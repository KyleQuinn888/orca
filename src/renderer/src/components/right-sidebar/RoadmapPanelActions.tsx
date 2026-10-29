// Split from RoadmapPanel (file-size lint): inbox actions + session delete button.

import { useState } from 'react'
import { useAppStore } from '@/store'
import { useRoadmapR2 } from '../roadmap-canvas/roadmap-r2-store'

export function InboxActions({
  worktreePath,
  group
}: {
  worktreePath: string | null
  group: { proposalGroupId: string; session: string }
}): React.JSX.Element {
  const phase = useRoadmapR2((st) => st.inboxWrites[group.proposalGroupId])
  const errMsg = useRoadmapR2((st) => st.inboxWriteError[group.proposalGroupId])
  const setReviewOpen = useRoadmapR2((st) => st.setReviewOpen)
  if (phase === 'writing') {
    return <div className="mt-1 text-[10px] text-[#4fc1ff]">排队/写入中 · 等待重组…</div>
  }
  if (phase === 'error') {
    return <div className="mt-1 text-[10px] text-[#f0883e]">失败：{errMsg || '未知'}</div>
  }
  return (
    <button
      className="mt-1.5 w-full rounded border border-[#4fc1ff] px-2 py-1 text-[11px] font-semibold text-[#4fc1ff] hover:bg-[#4fc1ff1a]"
      onClick={() => {
        setReviewOpen(group.proposalGroupId)
        if (worktreePath) {
          // review surface lives in the canvas tab (timeline stays visible as context)
          const wt = useAppStore
            .getState()
            .getKnownWorktreeById(useAppStore.getState().activeWorktreeId ?? '')
          if (wt) {
            useAppStore.getState().openRoadmapCanvas(wt.id)
          }
        }
      }}
    >
      审查详情 ›
    </button>
  )
}

export function SessionDeleteButton({
  worktreePath,
  sessionId,
  sessionTitle
}: {
  worktreePath: string | null
  sessionId: string
  sessionTitle: string
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  return confirming ? (
    <span className="flex items-center gap-1 text-[10px]" onClick={(e) => e.stopPropagation()}>
      <span className="text-[#f0883e]">删产物并留聊天记录？</span>
      <button
        className="rounded border border-[#f0883e] px-1 text-[#f0883e]"
        onClick={() => {
          if (!worktreePath) {
            return
          }
          void window.api.roadmap.deleteSession({ sessionId }).then((r) => {
            setConfirming(false)
            setResult(r.ok ? '已删除' : (r.error ?? '失败'))
          })
        }}
      >
        确认
      </button>
      <button
        className="rounded border border-border px-1 text-muted-foreground"
        onClick={() => setConfirming(false)}
      >
        取消
      </button>
      {result && <span className="text-muted-foreground">{result}</span>}
    </span>
  ) : (
    <button
      className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground hover:text-[#f0883e]"
      title={`删除 ${sessionTitle} 的传记产物（聊天记录保留，不可恢复）`}
      onClick={(e) => {
        e.stopPropagation()
        setConfirming(true)
      }}
    >
      删除产物
    </button>
  )
}
