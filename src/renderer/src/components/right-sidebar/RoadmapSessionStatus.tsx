// Session-scoped roadmap STATUS line (owner: moved below the card — the inline
// badge was occluded by row trailing actions). Read-only; actions live in the
// session action menu (RoadmapMenuItems).

import { useEffect, useState } from 'react'

type SessionInfo = {
  policy: string
  phase: 'idle' | 'generating'
  turns: number
  edits: number
  fileCount: number
}

export function RoadmapSessionStatus({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const [info, setInfo] = useState<SessionInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      const roadmapApi = window.api?.roadmap
      if (!roadmapApi) {
        return
      }
      void roadmapApi
        .sessionInfo({ sessionId })
        .then((r) => {
          if (!cancelled) {
            setInfo(r)
          }
        })
        .catch(() => {})
    }
    load()
    const timer = window.setInterval(load, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId])

  if (!info) {
    return null
  }

  const generating = info.phase === 'generating'
  const label =
    info.policy === 'deleted'
      ? '路线图已删除'
      : info.policy === 'excluded'
        ? '路线图已停止'
        : generating
          ? '路线图生成中…'
          : info.policy === 'eligible'
            ? '路线图记录中'
            : `未记录 · 轮 ${info.turns}/文件 ${info.fileCount}`

  const dot = generating
    ? 'animate-pulse bg-[#4fc1ff]'
    : info.policy === 'deleted'
      ? 'bg-[#8b949e]'
      : info.policy === 'excluded'
        ? 'bg-[#f0883e]'
        : info.policy === 'eligible'
          ? 'bg-[#3fb950]'
          : 'bg-[#4b4b4b]'

  return (
    <div
      className="mt-0.5 flex items-center gap-1 text-[10.5px] leading-none text-muted-foreground"
      title={`路线图 · 轮 ${info.turns} / 编辑 ${info.edits} / 文件 ${info.fileCount}（开关在会话菜单里）`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </div>
  )
}
