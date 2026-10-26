// Project canvas host — a virtual editor tab (check-details pattern) rendering
// the R2 timeline + inspector from the shared roadmap store.

import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useAppStore } from '@/store'
import { resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { translate } from '@/i18n/i18n'
import { useRoadmapR2 } from './use-roadmap-r2'
import { useRoadmapR2 as useR2Store } from './roadmap-r2-store'
import { CanvasTimeline } from './CanvasTimeline'
import { CanvasInspector } from './CanvasInspector'
import { computeLayout } from '../../../../../roadmap/core/r2-layout'
import { deriveRelations } from '../../../../../roadmap/core/r2-chains'

type ZoomPreset = { id: string; dayPx: number; labelKey: string; labelDefault: string }
const ZOOM_PRESETS: ZoomPreset[] = [
  { id: 'month', dayPx: 32, labelKey: 'auto.components.roadmap.canvasZoomMonth', labelDefault: '月' },
  { id: 'week', dayPx: 64, labelKey: 'auto.components.roadmap.canvasZoomWeek', labelDefault: '周' },
  { id: 'day', dayPx: 150, labelKey: 'auto.components.roadmap.canvasZoomDay', labelDefault: '日' }
]

export default function RoadmapCanvasPanel({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const worktree = useAppStore((s) => s.getKnownWorktreeById(worktreeId) ?? null)
  const worktreePath = worktree?.path ?? null
  const { loading, error, exists, snapshot, relations } = useRoadmapR2(worktreePath)
  const selection = useR2Store((s) => s.selection)
  const expandedSid = useR2Store((s) => s.expandedSid)
  const select = useR2Store((s) => s.select)
  const setExpandedSid = useR2Store((s) => s.setExpandedSid)
  const [dayPx, setDayPx] = useState(32)
  const [uiScale, setUiScale] = useState(1)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) {
        return
      }
      e.preventDefault()
      setUiScale((cur) => Math.max(0.75, Math.min(2.5, +(cur + (e.deltaY < 0 ? 0.15 : -0.15)).toFixed(2))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const fitDayPx = useMemo(() => {
    if (!snapshot || !relations) {
      return 32
    }
    const width = (scrollRef.current?.clientWidth ?? 1200) - 110
    const probe = computeLayout(snapshot, relations, { dayPx: 32 })
    return Math.max(4, Math.min(300, probe.fitDayPx(Math.max(width, 200))))
  }, [snapshot, relations])

  const openChapterCard = (file: string): void => {
    if (!worktreePath || !worktree) {
      return
    }
    useAppStore.getState().openFile(
      {
        filePath: resolveRuntimePath(resolveRuntimePath(worktreePath, '.roadmap'), file),
        relativePath: `.roadmap/${file}`,
        worktreeId,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true, focusEditor: true, suppressActiveRuntimeFallback: true }
    )
  }

  if (!worktreePath) {
    return <Center>{translate('auto.components.roadmap.canvasWorktreeGone', '工作区不可用。')}</Center>
  }
  if (loading && !snapshot) {
    return <Center><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />{translate('auto.components.roadmap.canvasLoading', '载入项目画布…')}</Center>
  }
  if (error) {
    return <Center>{translate('auto.components.roadmap.canvasError', '读取 .roadmap 失败')}：{error}</Center>
  }
  if (!exists || !snapshot || !relations) {
    return <Center>{translate('auto.components.roadmap.canvasEmpty', '这个项目还没有可读取的路线图。')}</Center>
  }

  const handleSelect = (sel: Parameters<typeof select>[0]): void => {
    select(sel)
    if (sel.level === 'chapter') {
      setExpandedSid(sel.sid)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-[#1e1e1e]">
      {/* toolbar */}
      <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-1.5 text-[11.5px]">
        <span className="text-muted-foreground">{translate('auto.components.roadmap.canvasZoom', '缩放')}</span>
        <div className="flex overflow-hidden rounded border border-[#4b4b4b]">
          {ZOOM_PRESETS.map((z) => (
            <button
              key={z.id}
              className={`border-none px-2.5 py-0.5 text-[11px] ${dayPx === z.dayPx ? 'bg-[#4fc1ff] font-semibold text-[#1e1e1e]' : 'bg-transparent text-muted-foreground'}`}
              onClick={() => setDayPx(z.dayPx)}
            >
              {translate(z.labelKey, z.labelDefault)}
            </button>
          ))}
          <button
            className="border-none bg-transparent px-2.5 py-0.5 text-[11px] text-muted-foreground"
            onClick={() => setDayPx(fitDayPx)}
          >
            {translate('auto.components.roadmap.canvasZoomFit', '适配')}
          </button>
        </div>
        <div className="ml-auto flex gap-3 text-[10.5px] text-muted-foreground">
          <span className="text-[#58a6ff]">╌▶ {translate('auto.components.roadmap.legendCont', '接续（推断）')}</span>
          <span className="text-[#6a6a6a]">▮ {translate('auto.components.roadmap.legendOverlap', '重叠带 = 并行')}</span>
          <span>{translate('auto.components.roadmap.legendVerified', '实线格=已验 · 虚线格=未验')}</span>
          <span>{translate('auto.components.roadmap.legendFork', 'fork 检测：当前未检出')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
            onClick={() => setUiScale((cur) => Math.max(0.75, +(cur - 0.15).toFixed(2)))}
          >
            −
          </button>
          <span className="w-10 text-center text-[11px] text-muted-foreground">{Math.round(uiScale * 100)}%</span>
          <button
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
            onClick={() => setUiScale((cur) => Math.min(2.5, +(cur + 0.15).toFixed(2)))}
          >
            ＋
          </button>
        </div>
        <button className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground" onClick={() => setInspectorOpen((v) => !v)}>
          {inspectorOpen ? '→' : '←'}
        </button>
      </div>
      {/* canvas + inspector */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
          <div className="mx-10 mb-16 mt-5 ml-[60px]">
            <CanvasTimeline
              snapshot={snapshot}
              relations={relations}
              dayPx={dayPx}
              expandedSid={expandedSid}
              selection={selection}
              onSelect={handleSelect}
              onToggleExpand={setExpandedSid}
              uiScale={uiScale}
            />
          </div>
        </div>
        {inspectorOpen && (
          <aside className="h-[210px] max-h-[40%] flex-none overflow-y-auto scrollbar-sleek border-t border-border bg-[#252526] px-4 py-2.5">
            <CanvasInspector snapshot={snapshot} selection={selection} onSelect={handleSelect} onOpenChapter={openChapterCard} />
          </aside>
        )}
      </div>
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{children}</div>
}

/** Derivation re-export so the shell owns one import site for the fit probe. */
export function relationsOf(snapshot: Parameters<typeof deriveRelations>[0]): ReturnType<typeof deriveRelations> {
  return deriveRelations(snapshot)
}
