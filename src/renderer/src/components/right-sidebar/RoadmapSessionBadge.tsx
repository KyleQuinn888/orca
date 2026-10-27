// Session-scoped roadmap badge (S2, spec session-enablement v1.3 §8): state
// dot on the session row — click to toggle artifact generation for THIS session.

import { useEffect, useState } from 'react'

type SessionInfo = {
  policy: string
  phase: 'idle' | 'generating'
  turns: number
  edits: number
  fileCount: number
}

export function RoadmapSessionBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.roadmap
      .sessionInfo({ sessionId })
      .then((r) => {
        if (!cancelled) {
          setInfo(r)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sessionId, busy])

  if (!info) {
    return null
  }

  const on = info.policy === 'eligible'
  const generating = info.phase === 'generating'
  const terminal = info.policy === 'deleted'
  const excluded = info.policy === 'excluded'

  const label = terminal
    ? '已删除'
    : generating
      ? '生成中'
      : on
        ? '传记生成中'
        : excluded
          ? '已排除'
          : '未生成'

  const dot = generating
    ? 'animate-pulse bg-[#4fc1ff]'
    : on
      ? 'bg-[#3fb950]'
      : terminal
        ? 'bg-[#8b949e]'
        : excluded
          ? 'bg-[#f0883e]'
          : 'bg-[#4b4b4b]'

  const toggle = (): void => {
    if (terminal || generating) {
      return
    }
    setBusy(true)
    void window.api.roadmap
      .generateNow({ sessionId, expectedPolicy: info.policy })
      .then((r) => {
        if (!r.ok && r.error?.includes('state moved')) {
          // stale view: refresh happens via the busy->info reload
        }
        setBusy(false)
      })
      .catch(() => setBusy(false))
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border border-border px-1 text-[9px] leading-none text-muted-foreground ${
        terminal ? '' : 'cursor-pointer hover:border-[#4fc1ff]'
      }`}
      title={
        terminal
          ? '传记产物已删除（不可恢复开启）'
          : `${label} · 轮 ${info.turns} / 编辑 ${info.edits} / 文件 ${info.fileCount} · 点击${on ? '排除' : '生成'}（仅此会话）`
      }
      onClick={(e) => {
        e.stopPropagation()
        toggle()
      }}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}
