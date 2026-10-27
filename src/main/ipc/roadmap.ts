// Roadmap R2b write verbs — human review of LLM proposal groups (spec r2-ui.md
// v1.2 §1.1). Runs in main: the panel never writes marks itself; the aggregate
// lock's fencing epoch guards the atomic persist.

import { ipcMain } from 'electron'
import { join } from 'node:path'
import { AggregateLock } from '../../../roadmap/aggregation/aggregate-lock'
import { loadMarks, MarksStore } from '../../../roadmap/aggregation/marks-store'
import { verbReview } from '../../../roadmap/aggregation/verbs'
import { getRoadmapService } from '../roadmap/roadmap-bootstrap'

export type RoadmapReviewRequest = {
  worktreePath: string
  sessionId: string
  proposalGroupId: string
  decision: 'approve' | 'reject'
  reason?: string
}

export type RoadmapReviewResponse = { ok: true; message: string } | { ok: false; error: string }

export function registerRoadmapIpcHandlers(): void {
  ipcMain.handle('roadmap:sessionInfo', (_e, args: { sessionId: string }) => {
    const service = getRoadmapService()
    if (!service) {
      return null
    }
    return service.sessionInfo(args.sessionId)
  })
  ipcMain.handle(
    'roadmap:deleteSession',
    async (
      _e,
      args: { sessionId: string; expectedPolicy?: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      const service = getRoadmapService()
      if (!service) {
        return { ok: false, error: 'roadmap service unavailable' }
      }
      return service.deleteSession(args.sessionId, args.expectedPolicy)
    }
  )
  ipcMain.handle(
    'roadmap:generateNow',
    async (
      _e,
      args: { sessionId: string; expectedPolicy: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      const service = getRoadmapService()
      if (!service) {
        return { ok: false, error: 'roadmap service unavailable' }
      }
      // Server-side revalidation (spec §1 L3): the renderer's view may be stale.
      const info = service.sessionInfo(args.sessionId)
      if (info.policy !== args.expectedPolicy) {
        return { ok: false, error: `state moved: ${info.policy}` }
      }
      return service.generateNow(args.sessionId)
    }
  )
  ipcMain.handle(
    'roadmap:reviewProposal',
    async (_event, args: RoadmapReviewRequest): Promise<RoadmapReviewResponse> => {
      try {
        if (!args?.worktreePath || !args?.proposalGroupId || !args.sessionId) {
          return { ok: false, error: 'worktreePath, sessionId and proposalGroupId are required' }
        }
        if (args.decision !== 'approve' && args.decision !== 'reject') {
          return { ok: false, error: 'decision must be approve or reject' }
        }
        const dir002 = join(args.worktreePath, '.roadmap', '002')
        const lock = AggregateLock.acquire(dir002)
        try {
          const loaded = loadMarks(dir002)
          if (!loaded.ok) {
            return { ok: false, error: `marks unavailable: ${loaded.error}` }
          }
          const store = new MarksStore(dir002, lock, loaded.events)
          const message = verbReview(
            store,
            [...loaded.events],
            args.sessionId,
            args.proposalGroupId,
            args.decision,
            args.reason ?? 'r2:inbox'
          )
          if (message.startsWith('REFUSED')) {
            return { ok: false, error: message }
          }
          return { ok: true, message }
        } finally {
          // Why mandatory: acquire() starts a heartbeat interval — in the main
          // process a missing release holds the aggregate lock forever.
          lock.release()
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
