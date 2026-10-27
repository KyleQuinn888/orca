// Deletion state machine split out of roadmap-service (file-size lint).
// Implements spec session-enablement v1.3 SS2/SS3: any non-terminal state may
// delete; durable intent first; idempotent resume.

import type { RoadmapServiceDeps } from './roadmap-service'
import { type RoadmapStateV2, setPolicy } from './roadmap-store'
import { deleteSessionArtifacts } from './session-delete'
import { scopeFor } from './session-id-bridge'

export type DeleteOpCtx = {
  state: RoadmapStateV2
  expectedPolicyFor: () => string | undefined
  isBusy: () => boolean
  waitForIdle: () => Promise<void>
  save: () => void
  deps: RoadmapServiceDeps
}

export async function deleteSessionOp(
  ctx: DeleteOpCtx,
  sessionId: string,
  resume = false
): Promise<{ ok: boolean; error?: string }> {
  const { state, save, deps } = ctx
  const current = state.policy[sessionId] ?? 'candidate'
  if (!resume) {
    if (
      ctx.expectedPolicyFor() &&
      ctx.expectedPolicyFor() !== 'candidate' &&
      current !== ctx.expectedPolicyFor()
    ) {
      return { ok: false, error: `state moved: ${current}` }
    }
    if (current === 'deleted') {
      return { ok: false, error: 'already deleted' }
    }
    // durable intent FIRST (spec SS3.1)
    state.ops = { ...state.ops, [sessionId]: 'deleting' }
    setPolicy(state, sessionId, 'excluded')
    save()
  }
  if (ctx.isBusy()) {
    await ctx.waitForIdle()
  }
  const result = await deleteSessionArtifacts(
    {
      ...deps,
      resolveWorkspaceForNative: (nativeId) =>
        scopeFor(deps.getUserDataDir(), nativeId, null).workspacePath
    },
    sessionId
  )
  if (!result.ok) {
    return result
  }
  const { ...rest } = state.ops ?? {}
  delete rest[sessionId]
  state.ops = rest
  setPolicy(state, sessionId, 'deleted')
  save()
  return { ok: true }
}
