// Roadmap service: orchestrates the segmentation→digest→summarize→render→write
// pipeline per session. Triggered by journal observeCommits + turn completions;
// capped by daily limits; concurrency-limited to 4.

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  getOrCreateSession,
  isActive,
  isTerminal,
  metricsOf,
  setPolicy,
  type RoadmapStateV2
} from './roadmap-store'
import { parseRow } from './journal-row-parse'
import { deleteSessionOp } from './session-ops'
import { crossesThreshold, foldRowsIntoMetrics } from './session-threshold'
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
  /** L1 feature switch (spec §1): OFF rejects new generation per-trigger (no
   * restart needed). TODO(next): wire to the persisted GlobalSettings store —
   * today the boot-time settings.sessionRoadmap check is a phantom (comment only).
   */
  featureEnabled?: () => boolean
}

export type RoadmapService = {
  start(): void
  stop(): void
  optInSession(sessionId: string): void
  optOutSession(sessionId: string): void
  backfill(): Promise<void>
  /** Manual generate (spec §2): bypasses threshold, refused for terminal states. */
  generateNow(sessionId: string): Promise<{ ok: boolean; error?: string }>
  /** Badge state for the session title bar (S2). */
  sessionInfo(sessionId: string): {
    policy: string
    phase: 'idle' | 'generating'
    turns: number
    edits: number
    fileCount: number
  }
  /** Delete one session's artifacts (spec §3); tombstones on success. */
  deleteSession(
    sessionId: string,
    expectedPolicy?: string
  ): Promise<{ ok: boolean; error?: string }>
  /** Startup reconciliation: resume interrupted deletions (spec §3.6). */
  resumeDeletions(): Promise<void>
}

// ─── Service implementation ─────────────────────────────────────────────

export function createRoadmapService(
  deps: RoadmapServiceDeps,
  state: RoadmapStateV2
): RoadmapService {
  const openChapters = new Map<string, OpenChapter | null>()
  const activeTasks = new Map<string, Promise<void>>()
  const unsubscribers: (() => void)[] = []
  let running = false
  const promptTemplate = readFileSync(
    join(process.cwd(), 'roadmap', 'prompts', 'task-node.md'),
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
    // Terminal states (excluded/deleted) override every writer (spec §0)
    if (!running || !deps.isLocalSession(sessionId) || isTerminal(state, sessionId)) {
      return
    }
    // durable deleting intent blocks generation until deletion completes (spec §3.1)
    if (state.ops?.[sessionId] === 'deleting') {
      return
    }
    if (deps.featureEnabled && !deps.featureEnabled()) {
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

    // Threshold auto-policy (spec §1 L2): candidates accumulate metrics from the
    // same rows WITHOUT advancing the cursor, so nothing is lost while a session
    // is still below threshold; crossing promotes to eligible and this same
    // trigger then processes from the original cursor.
    if (!isActive(state, sessionId)) {
      const m = metricsOf(state, sessionId)
      for (const row of rows) {
        const parsed = parseRow(row.rowJson)
        if (parsed) {
          foldRowsIntoMetrics(m, [parsed])
        }
      }
      if (crossesThreshold(m)) {
        setPolicy(state, sessionId, 'eligible')
        saveStateSafe(deps, state)
      } else {
        saveStateSafe(deps, state) // persist metrics incrementally
        return
      }
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
      // Publish-point recheck: exclusion/deletion requested mid-flight discards
      // this chapter without writing (spec §2 M4 ruling)
      if (isTerminal(state, sessionId)) {
        return
      }
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
    // Manual generate/override: refused for deleted (irreversible), un-excludes
    // excluded sessions (spec §2 M3)
    if (state.policy[sessionId] === 'deleted') {
      return
    }
    setPolicy(state, sessionId, 'eligible')
    saveStateSafe(deps, state)
  }

  function optOutSession(sessionId: string): void {
    if (state.policy[sessionId] === 'deleted') {
      return
    }
    setPolicy(state, sessionId, 'excluded')
    saveStateSafe(deps, state)
  }

  function sessionInfo(sessionId: string): {
    policy: string
    phase: 'idle' | 'generating'
    turns: number
    edits: number
    fileCount: number
  } {
    const m = metricsOf(state, sessionId)
    return {
      policy: state.policy[sessionId] ?? 'candidate',
      phase: activeTasks.has(sessionId) ? 'generating' : 'idle',
      turns: m.turns,
      edits: m.edits,
      fileCount: m.fileCount
    }
  }

  async function generateNow(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    if (!deps.isLocalSession(sessionId)) {
      return { ok: false, error: 'not a local session' }
    }
    // Terminal states are irreversible (spec §2): deleted refuses, excluded may un-exclude
    if (state.policy[sessionId] === 'deleted') {
      return { ok: false, error: 'session deleted' }
    }
    setPolicy(state, sessionId, 'eligible')
    saveStateSafe(deps, state)
    await processSession(sessionId, 'manual-generate')
    return { ok: true }
  }

  async function deleteSession(
    sessionId: string,
    expectedPolicy?: string
  ): Promise<{ ok: boolean; error?: string }> {
    return deleteSessionOp(
      {
        state,
        expectedPolicyFor: () => expectedPolicy,
        isBusy: () => activeTasks.has(sessionId),
        waitForIdle: async () => {
          while (activeTasks.has(sessionId)) {
            await activeTasks.get(sessionId)
          }
        },
        save: () => saveStateSafe(deps, state),
        deps
      },
      sessionId
    )
  }

  async function resumeDeletions(): Promise<void> {
    for (const sessionId of Object.entries(state.ops ?? {})
      .filter(([, op]) => op === 'deleting')
      .map(([sid]) => sid)) {
      const result = await deleteSessionOp(
        {
          state,
          expectedPolicyFor: () => undefined,
          isBusy: () => activeTasks.has(sessionId),
          waitForIdle: async () => {},
          save: () => saveStateSafe(deps, state),
          deps
        },
        sessionId,
        true
      )
      void result
    }
  }

  async function backfill(): Promise<void> {
    // Tombstone gate (spec §2 M7): only policy-eligible sessions; terminal
    // states are never revived by backfill.
    const eligible = Object.entries(state.policy)
      .filter(([, p]) => p === 'eligible')
      .map(([sid]) => sid)
    console.log(`[roadmap] backfill: scanning ${eligible.length} eligible sessions`)
    for (const sessionId of eligible) {
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
        try {
          await processSession(sessionId, 'backfill')
        } catch (e) {
          console.error(`[roadmap] backfill processSession threw:`, e)
        }
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

  return {
    start,
    stop,
    optInSession,
    optOutSession,
    backfill,
    generateNow,
    sessionInfo,
    deleteSession,
    resumeDeletions
  }
}
