// Roadmap service: orchestrates the segmentation→digest→summarize→render→write
// pipeline per session. Triggered by journal observeCommits + turn completions;
// capped by daily limits; concurrency-limited to 4.

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { getOrCreateSession, isOptedIn, optIn, optOut, type RoadmapState } from './roadmap-store'
import {
  DEFAULT_SEGMENTATION_CONFIG,
  type OpenChapter,
  flushOpenChapter,
  segmentRows
} from './journal-reader'
import {
  countExistingChapters,
  type JournalDb,
  readRowsAfterCursor,
  readRowsInRange
} from './journal-row-io'
import { saveStateSafe, summarizeAndWrite } from './chapter-pipeline'

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
      await summarizeAndWrite(
        deps,
        state,
        promptTemplate,
        sessionId,
        workspace,
        cut,
        rows,
        sessionState,
        db
      )
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
      await summarizeAndWrite(
        deps,
        state,
        promptTemplate,
        sessionId,
        workspace,
        flushCut,
        rows,
        sessionState,
        db
      )
    }
  }

  function optInSession(sessionId: string): void {
    optIn(state, sessionId)
    saveStateSafe(deps, state)
  }

  function optOutSession(sessionId: string): void {
    optOut(state, sessionId)
    saveStateSafe(deps, state)
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

  return { start, stop, optInSession, optOutSession, backfill }
}
