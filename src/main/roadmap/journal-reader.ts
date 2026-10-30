// Journal chapter segmentation: reads raw journal rows and cuts them into
// chapters at meaningful work-unit boundaries. Three tiers of signals
// (hard/candidate/size-overflow) plus a flush channel, per the R1 spec
// (triple-reviewed: dual adversarial + Codex final).
//
// Cut-point signals (TIER 0-2) and flush signals are ORTHOGONAL:
// - Cut-point: WHERE to split (compact, epoch, git commit, threadGoal, etc.)
// - Flush: WHEN to close an open chapter (idle, app exit, session close)

import {
  estimateProjectionChars,
  isCompactRow,
  isGitCommit,
  isOrcaStop,
  isSlashCommand,
  isTerminalTurn,
  isThreadGoalChange,
  parseRow
} from './journal-row-parse'

// ─── Types ──────────────────────────────────────────────────────────────

export type JournalEpoch = string

export type JournalRowRef = {
  sessionId: string
  epoch: JournalEpoch
  seq: number
  rowJson: string
  ts?: number
}

export type TurnTerminalState = 'completed' | 'interrupted' | 'unverifiable'

export type CutSignal =
  | { tier: 0; kind: 'compact' | 'epoch-change'; atSeq: number }
  | {
      tier: 1
      kind: 'git-commit' | 'thread-goal' | 'orca-stop' | 'slash-command'
      atSeq: number
      detail?: string
    }
  | { tier: 2; kind: 'size-overflow'; atSeq: number; forced: true }
  | { tier: 2; kind: 'flush'; atSeq: number; forced: false }

export type ChapterCut = {
  index: number
  signal: CutSignal
  /** Inclusive range of journal rows in this chapter. */
  fromSeq: number
  toSeq: number
  epoch: JournalEpoch
}

export type SegmentationConfig = {
  /** Minimum terminal turns before TIER 1 signals can trigger a cut. */
  floor: number
  /** Maximum terminal turns before TIER 2 forces a cut. */
  maxTurns: number
  /** Maximum digest projection chars before TIER 2 forces a cut (0.8 * digest budget). */
  maxProjectionChars: number
  /** How many turns to search backward for a good boundary. */
  backtrackWindow: number
}

export const DEFAULT_SEGMENTATION_CONFIG: SegmentationConfig = {
  floor: 8,
  maxTurns: 50,
  maxProjectionChars: 19_200, // 0.8 * 24k
  backtrackWindow: 20
}

// ─── Segmentation state ─────────────────────────────────────────────────

/** TIER 1 boundary candidate recorded while a chapter stays open. */
export type CutCandidate = {
  tier: 1
  kind: 'git-commit' | 'thread-goal' | 'orca-stop' | 'slash-command'
  atSeq: number
  detail?: string
}

export type OpenChapter = {
  epoch: JournalEpoch
  startSeq: number
  terminalTurns: number
  /** Seq of the most recent terminal turn — the backtrack fallback position. */
  lastTerminalSeq: number
  projectionChars: number
  /** Best boundary candidates found so far, in priority order. */
  candidates: CutCandidate[]
}

export type SegmentationResult = {
  cuts: ChapterCut[]
  open: OpenChapter | null
}

// ─── Main segmentation function ─────────────────────────────────────────

/**
 * Segment journal rows into chapters. Call this with batches of rows
 * (from observeCommits or turn completion); it maintains segmentation state
 * in `open` across calls.
 */
export function segmentRows(
  _sessionId: string,
  rows: JournalRowRef[],
  open: OpenChapter | null,
  config: SegmentationConfig = DEFAULT_SEGMENTATION_CONFIG,
  chapterIndexStart = 1
): SegmentationResult {
  const cuts: ChapterCut[] = []
  let chapterIndex = chapterIndexStart
  let currentOpen: OpenChapter | null = open
  let lastEpoch: JournalEpoch | null = open?.epoch ?? null

  for (const row of rows) {
    const parsed = parseRow(row.rowJson)
    if (!parsed) {
      continue
    }

    // ── TIER 0: compact ──
    if (isCompactRow(parsed)) {
      if (currentOpen && currentOpen.terminalTurns > 0) {
        cuts.push({
          index: chapterIndex++,
          signal: { tier: 0, kind: 'compact', atSeq: row.seq },
          fromSeq: currentOpen.startSeq,
          toSeq: row.seq - 1,
          epoch: currentOpen.epoch
        })
      }
      currentOpen = null
      lastEpoch = row.epoch
      continue
    }

    // ── TIER 0: epoch change ──
    if (lastEpoch !== null && row.epoch !== lastEpoch) {
      if (currentOpen && currentOpen.terminalTurns > 0) {
        cuts.push({
          index: chapterIndex++,
          signal: { tier: 0, kind: 'epoch-change', atSeq: row.seq },
          fromSeq: currentOpen.startSeq,
          toSeq: row.seq - 1,
          epoch: lastEpoch
        })
      }
      currentOpen = null
      lastEpoch = row.epoch
      continue
    }

    // Start a new open chapter if none
    if (!currentOpen) {
      currentOpen = {
        epoch: row.epoch,
        startSeq: row.seq,
        terminalTurns: 0,
        lastTerminalSeq: row.seq,
        projectionChars: 0,
        candidates: []
      }
    }

    // ── Count terminal turns ──
    const terminalState = isTerminalTurn(parsed)
    if (terminalState) {
      currentOpen.terminalTurns++
      currentOpen.lastTerminalSeq = row.seq
    }

    // ── Accumulate projection size (rough estimate) ──
    currentOpen.projectionChars += estimateProjectionChars(parsed)

    // ── TIER 1 signals (record as candidates, don't cut yet) ──
    const commitDetail = isGitCommit(parsed)
    if (commitDetail) {
      currentOpen.candidates.push({
        tier: 1,
        kind: 'git-commit',
        atSeq: row.seq,
        detail: commitDetail
      })
    }
    const goalChange = isThreadGoalChange(parsed)
    if (goalChange) {
      currentOpen.candidates.push({
        tier: 1,
        kind: 'thread-goal',
        atSeq: row.seq,
        detail: goalChange
      })
    }
    if (isOrcaStop(parsed)) {
      currentOpen.candidates.push({ tier: 1, kind: 'orca-stop', atSeq: row.seq })
    }
    const slashName = isSlashCommand(parsed)
    if (slashName) {
      currentOpen.candidates.push({
        tier: 1,
        kind: 'slash-command',
        atSeq: row.seq,
        detail: slashName
      })
    }

    // ── TIER 1: eager cut if floor met and a signal just fired ──
    if (currentOpen.terminalTurns >= config.floor && currentOpen.candidates.length > 0) {
      const last = currentOpen.candidates.at(-1)!
      if (last.atSeq === row.seq) {
        cuts.push({
          index: chapterIndex++,
          signal: { tier: last.tier, kind: last.kind, atSeq: last.atSeq, detail: last.detail },
          fromSeq: currentOpen.startSeq,
          toSeq: row.seq,
          epoch: currentOpen.epoch
        })
        currentOpen = null
        continue
      }
    }

    // ── TIER 2: size overflow + backtrack ──
    const sizeExceeded =
      currentOpen.terminalTurns >= config.maxTurns ||
      currentOpen.projectionChars >= config.maxProjectionChars

    if (sizeExceeded && currentOpen.terminalTurns >= config.floor) {
      const best = findBestBacktrack(currentOpen, config)
      cuts.push({
        index: chapterIndex++,
        signal: { tier: 2, kind: 'size-overflow', atSeq: best.atSeq, forced: true },
        fromSeq: currentOpen.startSeq,
        toSeq: best.atSeq,
        epoch: currentOpen.epoch
      })
      // Rows after the cut point start the next chapter
      currentOpen = {
        epoch: row.epoch,
        startSeq: best.atSeq + 1,
        terminalTurns: 0,
        lastTerminalSeq: best.atSeq + 1,
        projectionChars: 0,
        candidates: []
      }
    }
  }

  return { cuts, open: currentOpen }
}

/** Find the best backward boundary in the backtrack window. */
function findBestBacktrack(
  open: OpenChapter,
  config: SegmentationConfig
): { atSeq: number; kind: string } {
  const windowStart = Math.max(
    open.startSeq,
    open.startSeq + (open.terminalTurns - config.backtrackWindow)
  )
  const inWindow = open.candidates.filter((c) => c.atSeq >= windowStart)
  if (inWindow.length > 0) {
    const best = inWindow.at(-1)!
    return { atSeq: best.atSeq, kind: best.kind }
  }
  // Fallback: cut at the LAST TERMINAL TURN's actual seq — the old
  // `startSeq + terminalTurns` was meaningless arithmetic that put cuts at
  // arbitrary positions (e.g. seq 1+8=9 for a chapter spanning seq 1-5000,
  // leaving 99% of rows uncovered — soak day-3 root cause)
  return { atSeq: open.lastTerminalSeq, kind: 'forced' }
}

// ─── Flush: close the open chapter regardless of signals ───────────────

export function flushOpenChapter(
  _sessionId: string,
  open: OpenChapter | null,
  chapterIndex: number
): ChapterCut | null {
  if (!open || open.terminalTurns === 0) {
    return null
  }
  const best = open.candidates.at(-1)
  const toSeq = best ? best.atSeq : open.lastTerminalSeq
  return {
    index: chapterIndex,
    signal: { tier: 2, kind: 'flush', atSeq: toSeq, forced: false },
    fromSeq: open.startSeq,
    toSeq,
    epoch: open.epoch
  }
}
