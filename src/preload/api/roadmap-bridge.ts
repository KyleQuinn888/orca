// Roadmap R2b write-verb bridge: human review of proposal groups via main.
import { ipcRenderer } from 'electron'

export type RoadmapReviewRequest = {
  worktreePath: string
  sessionId: string
  proposalGroupId: string
  decision: 'approve' | 'reject'
  reason?: string
}

export type RoadmapReviewResponse = { ok: true; message: string } | { ok: false; error: string }

export type RoadmapApi = typeof roadmapApi

export const roadmapApi = {
  reviewProposal: (args: RoadmapReviewRequest): Promise<RoadmapReviewResponse> =>
    ipcRenderer.invoke('roadmap:reviewProposal', args),
  sessionInfo: (args: {
    sessionId: string
  }): Promise<{
    policy: string
    phase: 'idle' | 'generating'
    turns: number
    edits: number
    fileCount: number
  } | null> => ipcRenderer.invoke('roadmap:sessionInfo', args),
  generateNow: (args: {
    sessionId: string
    expectedPolicy: string
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('roadmap:generateNow', args),
  deleteSession: (args: {
    sessionId: string
    expectedPolicy?: string
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('roadmap:deleteSession', args)
}
