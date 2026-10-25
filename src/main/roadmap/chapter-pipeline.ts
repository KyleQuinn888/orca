// Chapter summarization pipeline: digest -> spawn -> render -> S6 -> write.
// Split from roadmap-service.ts for the max-lines ratchet.

import { join } from 'node:path'
import type { ChapterCut, JournalRowRef } from './journal-reader'
import { buildJournalDigest } from './journal-digest'
import { renderJournalCard, journalS6Lookup } from './render-journal'
import { verifyEvidence } from '../../../roadmap/core/anchor'
import { writeCard } from '../../../roadmap/core/card-io'
import { refreshIndex } from '../../../roadmap/core/index-card'
import {
  establishedTerms,
  termInjectionHeader,
  lintTerms
} from '../../../roadmap/core/term-consistency'
import { rebuildPitsIndex } from '../../../roadmap/core/pits-index'
import { summarizeChapter } from './summarizer-launch'
import {
  capRemaining,
  completePending,
  enqueuePending,
  recordSpawn,
  saveState,
  utcDateKey,
  type RoadmapState,
  type SessionState
} from './roadmap-store'
import { computeUncovered, type JournalDb } from './journal-row-io'

/** Narrow slice of the service deps the chapter pipeline needs. */
export type ChapterPipelineDeps = {
  getSessionTitle: (sessionId: string) => string
  getUserDataDir: () => string
}

export async function summarizeAndWrite(
  deps: ChapterPipelineDeps,
  state: RoadmapState,
  promptTemplate: string,
  sessionId: string,
  workspace: string,
  cut: ChapterCut,
  allRows: JournalRowRef[],
  sessionState: SessionState,
  db: JournalDb
): Promise<void> {
  const chapterRows = allRows.filter((r) => r.seq >= cut.fromSeq && r.seq <= cut.toSeq)
  if (chapterRows.length === 0) {
    return
  }

  const sessionTitle = deps.getSessionTitle(sessionId)
  const outDir = join(workspace, '.roadmap', '001', sessionId)

  // Check cap before spawning
  const dateKey = utcDateKey()
  const remaining = capRemaining(sessionState, dateKey)
  if (remaining <= 0) {
    // Cut but don't summarize — enqueue pending
    enqueuePending(sessionState, cut.epoch, cut.fromSeq, { epoch: cut.epoch, seq: cut.toSeq })
    console.warn(`[roadmap] daily cap exhausted for ${sessionId}, chapter ${cut.index} queued`)
    return
  }

  // Build digest with rolling terminology injection
  const termHeader = termInjectionHeader(establishedTerms(outDir, cut.index))
  const { digest, truncated } = buildJournalDigest(sessionId, sessionTitle, chapterRows, termHeader)

  // Summarize (one-shot spawn)
  const result = await summarizeChapter({ digest, promptTemplate })
  if (result.kind === 'heuristic') {
    // Service mode: skip, don't write degraded cards
    console.warn(
      `[roadmap] summarizer degraded for ${sessionId} ch${cut.index}: ${result.reason?.slice(0, 100)}`
    )
    enqueuePending(sessionState, cut.epoch, cut.fromSeq, { epoch: cut.epoch, seq: cut.toSeq })
    return
  }

  // Record spawn for cap counting
  recordSpawn(sessionState, dateKey)

  // Render card
  const tzOffsetMin = -new Date().getTimezoneOffset()
  const uncovered = computeUncovered(sessionId, cut, allRows)
  const card = renderJournalCard({
    sessionId,
    sessionTitle,
    workspace,
    cut,
    rows: chapterRows,
    summarized: result.card,
    provenance: 'llm',
    dbPath: deps.getUserDataDir(),
    profile: 'orca',
    tzOffsetMin,
    uncovered,
    digestTruncated: truncated
  })

  // S6 gate
  const s6 = journalS6Lookup(db as Parameters<typeof journalS6Lookup>[0])
  const checks = card.evidence
    .filter((e) => e.quote !== undefined && e.quote !== '')
    .map((e) => ({ claim: e.claim, quote: e.quote!, evidence: e }))
  const failures = verifyEvidence(checks, s6)
  if (failures.length > 0) {
    const failedClaims = new Set(failures.map((f) => f.claim))
    card.evidence = card.evidence.filter((e) => !failedClaims.has(e.claim))
    card.frontmatter.anchorsDropped = failures.length
    console.warn(`[roadmap] S6 dropped ${failures.length} anchors in ${sessionId} ch${cut.index}`)
  }

  // Stamp if all points covered
  const pointClaims = [...result.card.points.keys()].map((i) => `要点${i + 1}`)
  const coveredClaims = new Set(card.evidence.map((e) => e.claim))
  if (card.evidence.length > 0 && pointClaims.every((c) => coveredClaims.has(c))) {
    card.frontmatter.anchorsVerifiedAt = new Date().toISOString()
    card.frontmatter.extra['verifiedScope'] =
      'points-only; decisions/pits anchors counted in anchorsDropped'
  }

  // Write card
  const written = writeCard(outDir, card)
  console.log(
    `[roadmap] ${written.outcome}: ch${cut.index} evidence=${card.evidence.length} verified=${card.frontmatter.anchorsVerifiedAt !== undefined}`
  )

  // Advance summarizedCursor
  sessionState.summarizedCursor = { epoch: cut.epoch, seq: cut.toSeq }
  completePending(sessionState, `${cut.epoch}:${cut.fromSeq}`)

  // Refresh derived files (index + pits)
  refreshIndex(outDir, {
    source: 'orca-journal',
    session: sessionId,
    workspace,
    title: sessionTitle,
    chapters: [],
    sessionUncoveredNote: `Ch.${cut.index} closed`,
    tzOffsetMin
  })
  rebuildPitsIndex(workspace, new Set())

  // Term lint (non-blocking)
  const conflicts = lintTerms(outDir)
  if (conflicts.length > 0) {
    console.warn(
      `[roadmap] term drift: ${conflicts.map((c) => `「${c.jargon}」→${c.renderings.join('/')}`).join('; ')}`
    )
  }

  // Save state
  saveStateSafe(deps, state)
}

export function saveStateSafe(deps: ChapterPipelineDeps, state: RoadmapState): void {
  try {
    saveState(deps.getUserDataDir(), state)
  } catch (e) {
    console.warn(`[roadmap] state save failed: ${e}`)
  }
}
