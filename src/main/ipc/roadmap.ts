// Roadmap R2b write verbs — human review of LLM proposal groups (spec r2-ui.md
// v1.2 §1.1). Runs in main: the panel never writes marks itself; the aggregate
// lock's fencing epoch guards the atomic persist.

import { ipcMain } from 'electron'
import { join } from 'node:path'
import { AggregateLock } from '../../../roadmap/aggregation/aggregate-lock'
import { loadMarks, MarksStore } from '../../../roadmap/aggregation/marks-store'
import { verbReview } from '../../../roadmap/aggregation/verbs'

export type RoadmapReviewRequest = {
  worktreePath: string
  sessionId: string
  proposalGroupId: string
  decision: 'approve' | 'reject'
  reason?: string
}

export type RoadmapReviewResponse = { ok: true; message: string } | { ok: false; error: string }

export function registerRoadmapIpcHandlers(): void {
  ipcMain.handle('roadmap:reviewProposal', async (_event, args: RoadmapReviewRequest): Promise<RoadmapReviewResponse> => {
    try {
      if (!args?.worktreePath || !args?.proposalGroupId || !args.sessionId) {
        return { ok: false, error: 'worktreePath, sessionId and proposalGroupId are required' }
      }
      if (args.decision !== 'approve' && args.decision !== 'reject') {
        return { ok: false, error: 'decision must be approve or reject' }
      }
      const dir002 = join(args.worktreePath, '.roadmap', '002')
      const lock = AggregateLock.acquire(dir002)
      const loaded = loadMarks(dir002)
      if (!loaded.ok) {
        return { ok: false, error: `marks unavailable: ${loaded.error}` }
      }
      const store = new MarksStore(dir002, lock, loaded.events)
      const message = verbReview(store, [...loaded.events], args.sessionId, args.proposalGroupId, args.decision, args.reason ?? 'r2:inbox')
      if (message.startsWith('REFUSED')) {
        return { ok: false, error: message }
      }
      return { ok: true, message }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
