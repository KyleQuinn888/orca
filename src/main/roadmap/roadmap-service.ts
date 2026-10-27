// Roadmap service: orchestrates the segmentation→digest→summarize→render→write
// pipeline per session. Triggered by journal observeCommits + turn completions;
// capped by daily limits; concurrency-limited to 4.

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  getOrCreateSession,
  isTerminal,
  metricsOf,
  setPolicy,
  type RoadmapStateV2
} from './roadmap-store'
import { scopeFor, scopeForGeneration, type SessionIdScope } from './session-id-bridge'
import { flushSessionInner, processSessionInner, type ProcessCtx } from './session-process'
import { deleteSessionOp } from './session-ops'
import type { JournalDb } from './journal-row-io'
import type { OpenChapter } from './journal-reader'
import { saveStateSafe } from './chapter-pipeline'

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
  /** Prompt template location; packaged launches run from any cwd, so the
   * bootstrap anchors this inside app.asar instead of the repo checkout. */
  promptTemplatePath?: string
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
    deps.promptTemplatePath ?? join(process.cwd(), 'roadmap', 'prompts', 'task-node.md'),
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
        void flushSessionInner(ctxFor(sessionId), sessionId)
      })
    )
  }

  function ctxFor(_sessionId: string): ProcessCtx {
    return { deps, state, promptTemplate, openChapters }
  }

  function stop(): void {
    running = false
    for (const unsub of unsubscribers) {
      unsub()
    }
    unsubscribers.length = 0
    // Active tasks will complete or fail; no new ones are spawned
  }

  async function processSession(
    sessionId: string,
    trigger: string,
    preScope?: SessionIdScope
  ): Promise<void> {
    // Id bridge first: gates, state keys and serialization all live in the
    // native-id domain (auto triggers arrive as journal ids).
    const scope =
      preScope ?? scopeFor(deps.getUserDataDir(), sessionId, deps.getWorkspacePath(sessionId))
    const nativeId = scope.nativeId
    // Terminal states (excluded/deleted) override every writer (spec §0)
    if (!running || !deps.isLocalSession(nativeId) || isTerminal(state, nativeId)) {
      return
    }
    // durable deleting intent blocks generation until deletion completes (spec §3.1)
    if (state.ops?.[nativeId] === 'deleting') {
      return
    }
    if (deps.featureEnabled && !deps.featureEnabled()) {
      return
    }
    if (!deps.zcodeAvailable()) {
      return
    }

    // Per-session serialization on the native key
    if (activeTasks.has(nativeId)) {
      return
    }

    const ctx: ProcessCtx = { deps, state, promptTemplate, openChapters }
    const task = processSessionInner(ctx, sessionId, trigger, scope).finally(() => {
      activeTasks.delete(nativeId)
    })
    activeTasks.set(nativeId, task)
    await task
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
    // Resolve the native scope FIRST: policy keys live in the native domain
    const scope = scopeForGeneration(
      deps.getUserDataDir(),
      sessionId,
      deps.getWorkspacePath(sessionId)
    )
    const nativeId = scope.nativeId
    if (!deps.isLocalSession(nativeId)) {
      return { ok: false, error: 'not a local session' }
    }
    // Terminal states are irreversible (spec §2): deleted refuses, excluded may un-exclude
    if (state.policy[nativeId] === 'deleted') {
      return { ok: false, error: 'session deleted' }
    }
    setPolicy(state, nativeId, 'eligible')
    saveStateSafe(deps, state)
    await processSession(nativeId, 'manual-generate', scope)
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
