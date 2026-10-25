// Roadmap service: orchestrates the segmentation→digest→summarize→render→write
// pipeline per session. Triggered by journal observeCommits + turn completions;
// capped by daily limits; concurrency-limited to 4.

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  capRemaining,
  completePending,
  enqueuePending,
  getOrCreateSession,
  isOptedIn,
  optIn,
  optOut,
  recordSpawn,
  type RoadmapState,
  saveState,
  type SessionState,
  utcDateKey
} from './roadmap-store'
import {
  type ChapterCut,
  DEFAULT_SEGMENTATION_CONFIG,
  type JournalRowRef,
  type OpenChapter,
  flushOpenChapter,
  segmentRows
} from './journal-reader'
import { buildJournalDigest } from './journal-digest'
import { renderJournalCard, journalS6Lookup } from './render-journal'
import { verifyEvidence } from '../../roadmap/core/anchor'
import { writeCard } from '../../roadmap/core/card-io'
import { refreshIndex } from '../../roadmap/core/index-card'
import {
  establishedTerms,
  termInjectionHeader,
  lintTerms
} from '../../roadmap/core/term-consistency'
import { rebuildPitsIndex } from '../../roadmap/core/pits-index'
import { summarizeChapter } from './summarizer-launch'
import {
  computeUncovered,
  countExistingChapters,
  type JournalDb,
  readRowsAfterCursor,
  readRowsInRange
} from './journal-row-io'

// ─── Types ──────────────────────────────────────────────────────────────

export type RoadmapServiceDeps = {
  getJournalDb: (sessionId: string) => JournalDb | null
  getWorkspacePath: (sessionId: string) => string | null
  getSessionTitle: (sessionId: string) => string
  getUserDataDir: () => string
  isLocalSession: (sessionId: string) => boolean
  onJournalCommit: (listener: (sessionId: string) => void) => () => void
  onTurnCompletion: (listener: (event: { sessionId: string }) => void) => () => void
  onIdle: (listener: (sessionId: string) => void) => () => void
  zcodeAvailable: () => boolean
}

export type RoadmapService = {
  start(): void
  stop(): void
  optInSession(sessionId: string): void
  optOutSession(sessionId: string): void
  backfill(): Promise<void>
}

// ─── Service implementation ─────────────────────────────────────────────

export function createRoadmapService(
  deps: RoadmapServiceDeps,
  state: RoadmapState
): RoadmapService {
  const openChapters = new Map<string, OpenChapter | null>()
  const activeTasks = new Map<string, Promise<void>>()
  const unsubscribers: (() => void)[] = []
  let running = false
  const promptTemplate = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'roadmap', 'prompts', 'task-node.md'),
    'utf8'
  )

  function start(): void {
    if (running) {
      return
    }
    running = true

    // TIER 0 wakeup: journal commits (compact/epoch between turns)
    unsubscribers.push(
      deps.onJournalCommit((sessionId) => {
        void processSession(sessionId, 'journal-commit')
      })
    )

    // Turn completions
    unsubscribers.push(
      deps.onTurnCompletion((event) => {
        void processSession(event.sessionId, 'turn-completion')
      })
    )

    // Idle flush
    unsubscribers.push(
      deps.onIdle((sessionId) => {
        void flushSession(sessionId)
      })
    )
  }

  function stop(): void {
    running = false
    for (const unsub of unsubscribers) {
      unsub()
    }
    unsubscribers.length = 0
    // Active tasks will complete or fail; no new ones are spawned
  }

  async function processSession(sessionId: string, trigger: string): Promise<void> {
    if (!running || !deps.isLocalSession(sessionId) || !isOptedIn(state, sessionId)) {
      return
    }
    if (!deps.zcodeAvailable()) {
      return
    }

    // Per-session serialization: skip if already processing
    if (activeTasks.has(sessionId)) {
      return
    }

    const task = processSessionInner(sessionId, trigger).finally(() => {
      activeTasks.delete(sessionId)
    })
    activeTasks.set(sessionId, task)
    await task
  }

  async function processSessionInner(sessionId: string, _trigger: string): Promise<void> {
    const db = deps.getJournalDb(sessionId)
    if (!db) {
      return
    }
    const sessionState = getOrCreateSession(state, sessionId)
    const workspace = deps.getWorkspacePath(sessionId)
    if (!workspace) {
      return
    }

    // Read new rows since scanCursor
    const rows = readRowsAfterCursor(db, sessionId, sessionState.scanCursor)
    if (rows.length === 0) {
      return
    }

    // Segment
    const open = openChapters.get(sessionId) ?? null
    const chapterIndex = countExistingChapters(workspace, sessionId) + 1
    const { cuts, open: newOpen } = segmentRows(
      sessionId,
      rows,
      open,
      DEFAULT_SEGMENTATION_CONFIG,
      chapterIndex
    )
    openChapters.set(sessionId, newOpen)

    // Update scanCursor to last row
    const lastRow = rows.at(-1)!
    sessionState.scanCursor = { epoch: lastRow.epoch, seq: lastRow.seq }

    // Process cuts (chapter closures)
    for (const cut of cuts) {
      await summarizeAndWrite(sessionId, workspace, cut, rows, sessionState, db)
    }
  }

  async function flushSession(sessionId: string): Promise<void> {
    const open = openChapters.get(sessionId)
    if (!open || open.terminalTurns === 0) {
      return
    }
    const workspace = deps.getWorkspacePath(sessionId)
    if (!workspace) {
      return
    }
    const sessionState = getOrCreateSession(state, sessionId)
    const db = deps.getJournalDb(sessionId)
    if (!db) {
      return
    }
    const chapterIndex = countExistingChapters(workspace, sessionId) + 1
    const flushCut = flushOpenChapter(sessionId, open, chapterIndex)
    if (flushCut) {
      openChapters.set(sessionId, null)
      const rows = readRowsInRange(db, sessionId, flushCut.epoch, flushCut.fromSeq, flushCut.toSeq)
      await summarizeAndWrite(sessionId, workspace, flushCut, rows, sessionState, db)
    }
  }

  async function summarizeAndWrite(
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
    const { digest, truncated } = buildJournalDigest(
      sessionId,
      sessionTitle,
      chapterRows,
      termHeader
    )

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
    saveStateSafe()
  }

  function saveStateSafe(): void {
    try {
      saveState(deps.getUserDataDir(), state)
    } catch (e) {
      console.warn(`[roadmap] state save failed: ${e}`)
    }
  }

  async function backfill(): Promise<void> {
    // Scan recent opt-in sessions without .roadmap/ and process them
    // Implementation depends on session enumeration API
    console.log('[roadmap] backfill: scanning opt-in sessions from last 7 days')
    for (const sessionId of state.optedIn) {
      const workspace = deps.getWorkspacePath(sessionId)
      if (!workspace) {
        continue
      }
      const outDir = join(workspace, '.roadmap', '001', sessionId)
      const hasCards = existsSyncSafe(outDir)
      const sessionState = getOrCreateSession(state, sessionId)
      if (
        !hasCards ||
        (sessionState.scanCursor.seq === 0 && sessionState.summarizedCursor.seq === 0)
      ) {
        await processSession(sessionId, 'backfill')
      }
    }
  }

  function existsSyncSafe(path: string): boolean {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  }

  function optInSession(sessionId: string): void {
    optIn(state, sessionId)
    saveStateSafe()
  }

  function optOutSession(sessionId: string): void {
    optOut(state, sessionId)
    saveStateSafe()
  }

  return { start, stop, optInSession, optOutSession, backfill }
}
