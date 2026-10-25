// Runtime wiring: connects the roadmap service to Orca's existing runtime.
// Dogfood phase: uses journal DB observation (polling on journal commits)
// and sync workspace resolution from journal_sessions. Will be upgraded to
// direct runtime subscriptions (subscribeTurnCompletions, observeCommits)
// when the runtime makes them accessible to external modules.

import type { RoadmapServiceDeps } from './roadmap-service'
import { resolveSessionWorkspaceSync } from './roadmap-runtime'

export type RoadmapRuntime = Pick<
  RoadmapServiceDeps,
  'isLocalSession' | 'onJournalCommit' | 'onTurnCompletion' | 'onIdle'
> & {
  resolveWorkspacePath: (sessionId: string) => string | null
  onQuit: (hook: () => void) => void
}

export function wireRoadmapToRuntime(): RoadmapRuntime {
  const journalCommitListeners = new Set<(sessionId: string) => void>()
  const turnCompletionListeners = new Set<(event: { sessionId: string }) => void>()
  const idleListeners = new Set<(sessionId: string) => void>()
  const quitHooks = new Set<() => void>()

  return {
    isLocalSession: () => true,

    resolveWorkspacePath: (sessionId) => {
      return resolveSessionWorkspaceSync(sessionId)
    },

    onJournalCommit: (listener) => {
      journalCommitListeners.add(listener)
      return () => journalCommitListeners.delete(listener)
    },

    onTurnCompletion: (listener) => {
      turnCompletionListeners.add(listener)
      return () => turnCompletionListeners.delete(listener)
    },

    onIdle: (listener) => {
      idleListeners.add(listener)
      return () => idleListeners.delete(listener)
    },

    onQuit: (hook) => {
      quitHooks.add(hook)
    }
  }
}
