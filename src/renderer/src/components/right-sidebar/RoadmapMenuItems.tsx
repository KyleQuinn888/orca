// Roadmap actions inside the session action menu (owner decision: the toggle
// moved from an inline badge — it was occluded — into this fold-out menu).
// Self-contained: reads state and invokes the roadmap IPC directly.

import { useEffect, useState } from 'react'
import { Map, Pause, Play } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ContextMenuItem } from '@/components/ui/context-menu'

type SessionInfo = {
  policy: string
  phase: 'idle' | 'generating'
  turns: number
  edits: number
  fileCount: number
}

export function RoadmapMenuItems({
  sessionId,
  menuKind
}: {
  sessionId: string
  menuKind: 'dropdown' | 'context'
}): React.JSX.Element | null {
  const [info, setInfo] = useState<SessionInfo | null>(null)

  useEffect(() => {
    let cancelled = false
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
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!info || info.policy === 'deleted') {
    return null
  }

  const run = (fn: () => Promise<unknown>): void => {
    void fn()
  }

  if (info.policy === 'eligible') {
    const stop = (): void =>
      run(() => window.api.roadmap.setPolicy({ sessionId, policy: 'excluded' }))
    return menuKind === 'dropdown' ? (
      <DropdownMenuItem onSelect={stop}>
        <Pause className="size-4" /> 停止记录路线图
      </DropdownMenuItem>
    ) : (
      <ContextMenuItem onSelect={stop}>
        <Pause className="size-4" /> 停止记录路线图
      </ContextMenuItem>
    )
  }

  const excluded = info.policy === 'excluded'
  const start = (): void =>
    run(() =>
      excluded
        ? window.api.roadmap.setPolicy({ sessionId, policy: 'eligible' })
        : window.api.roadmap.generateNow({ sessionId, expectedPolicy: info.policy })
    )
  const label = excluded ? '恢复路线图记录' : '为此会话生成路线图'

  return menuKind === 'dropdown' ? (
    <DropdownMenuItem onSelect={start}>
      {excluded ? <Play className="size-4" /> : <Map className="size-4" />} {label}
    </DropdownMenuItem>
  ) : (
    <ContextMenuItem onSelect={start}>
      {excluded ? <Play className="size-4" /> : <Map className="size-4" />} {label}
    </ContextMenuItem>
  )
}
