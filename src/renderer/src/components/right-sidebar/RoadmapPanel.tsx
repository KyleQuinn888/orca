// R2 sidebar panel — summary bar (opens the canvas tab) + review inbox +
// unified Session>Milestone>Chapter tree + pits view (spec r2-ui.md v1.2 §1).
// State lives in the shared roadmap-r2 store so the canvas tab links both ways.

import { LoaderCircle } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useActiveWorktreeId } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import type { Selection } from '../../../../../roadmap/core/r2-selection'
import { useRoadmapR2 as useR2Loader } from '../roadmap-canvas/use-roadmap-r2'
import { useRoadmapR2 } from '../roadmap-canvas/roadmap-r2-store'
import { MS_COLORS } from '../roadmap-canvas/CanvasTimeline'
import { RoadmapPitsView } from './RoadmapPanelViews'
import { useRoadmapPanelData } from './use-roadmap-panel-data'

export default function RoadmapPanel(): React.JSX.Element {
  const worktree = useActiveWorktree()
  const worktreeId = useActiveWorktreeId()
  const worktreePath = worktree?.path ?? null
  const { loading, exists, snapshot } = useR2Loader(worktreePath)
  const selection = useRoadmapR2((s) => s.selection)
  const sidebarView = useRoadmapR2((s) => s.sidebarView)
  const setSidebarView = useRoadmapR2((s) => s.setSidebarView)
  const select = useRoadmapR2((s) => s.select)
  const toggleTree = useRoadmapR2((s) => s.toggleTree)
  const toggleTreeMs = useRoadmapR2((s) => s.toggleTreeMs)
  const treeOpen = useRoadmapR2((s) => s.treeOpen)
  const treeMsOpen = useRoadmapR2((s) => s.treeMsOpen)
  const setExpandedSid = useRoadmapR2((s) => s.setExpandedSid)
  // Pits rows still come from the v1 parser; it reads the same KEYWORDS.md layer.
  const pitsData = useRoadmapPanelData(worktreePath)

  const chTotal = snapshot?.chapters.filter((c) => !c.superseded).length ?? 0
  const inbox = snapshot?.inbox ?? []

  const onSelect = (sel: Selection): void => {
    select(sel)
    if (sel.level === 'chapter') {
      setExpandedSid(sel.sid)
    }
  }

  const openCanvas = (): void => {
    if (worktreeId) {
      useAppStore.getState().openRoadmapCanvas(worktreeId)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* summary bar */}
      <div
        className="flex cursor-pointer items-center gap-1 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-[#2d2d30]"
        onClick={openCanvas}
        title={translate('auto.components.roadmap.canvasTabLabel', '项目画布')}
      >
        <span><b className="text-foreground">{snapshot?.sessions.length ?? 0}</b> session</span>·
        <span><b className="text-foreground">{chTotal}</b> 章</span>·
        <span><b className="text-foreground">{snapshot?.milestones.length ?? 0}</b> 里程碑</span>
        <span className="ml-auto text-[#4fc1ff]">打开项目画布 ›</span>
      </div>
      {/* inbox */}
      <div className="border-b border-border bg-[#d299220d] pb-2">
        <div className="px-3 pt-1.5 pb-1 text-[11px] text-[#d29922]">◇ 待审 {inbox.length}</div>
        {inbox.slice(0, 3).map((g) => (
          <div key={g.proposalGroupId} className="mx-2.5 rounded border border-dashed border-[#d29922] p-2 text-[11.5px]">
            <div className="mb-1 text-[10.5px] text-muted-foreground">
              LLM 提议 · {g.by} · {g.at.slice(0, 16).replace('T', ' ')}
            </div>
            {g.cuts.map((c) => (
              <div key={c.chapter} className="flex gap-1.5 py-0.5">
                <span className="font-semibold text-[#d29922]">Ch.{c.chapter} 前</span>
                <span className="min-w-0 flex-1 truncate" title={c.evidence}>{c.evidence}</span>
              </div>
            ))}
            <div className="mt-1 text-[10px] text-muted-foreground">◷ 72h 自动转正 · 批准/拒绝 R2b 接入</div>
          </div>
        ))}
        {inbox.length === 0 && <div className="px-3 text-[10.5px] text-muted-foreground">✓ 没有待审切点</div>}
      </div>
      {/* tabs */}
      <div className="flex border-b border-border">
        {(['sessions', 'pits'] as const).map((v) => (
          <div
            key={v}
            className={`flex-1 cursor-pointer border-b-2 py-1.5 text-center text-[12px] ${sidebarView === v ? 'border-[#4fc1ff] text-[#e8e8e8]' : 'border-transparent text-muted-foreground'}`}
            onClick={() => setSidebarView(v)}
          >
            {v === 'sessions'
              ? translate('auto.components.right.sidebar.RoadmapPanel.sessionsView', 'Sessions')
              : translate('auto.components.right.sidebar.RoadmapPanel.pitsView', 'Pits')}
          </div>
        ))}
      </div>
      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto worktree-sidebar-scrollbar">
        {loading && !snapshot && (
          <div className="flex items-center justify-center gap-2 p-4 text-[11.5px] text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {translate('auto.components.right.sidebar.RoadmapPanel.loading', 'Reading roadmap')}
          </div>
        )}
        {!loading && !exists && (
          <div className="p-4 text-[11.5px] text-muted-foreground">
            {translate('auto.components.right.sidebar.RoadmapPanel.noRoadmap', 'No roadmap yet')}
          </div>
        )}
        {sidebarView === 'sessions' && snapshot && (
          <div className="py-1">
            {snapshot.sessions.map((s) => {
              const open = treeOpen[s.id] ?? true
              const sessSel = selection.level !== 'project' && selection.sid === s.id
              const ms = snapshot.milestones
                .filter((m) => m.session === s.id)
                .sort((a, b) => (a.firstTime < b.firstTime ? -1 : 1))
              const msOrder = [...snapshot.milestones].sort((a, b) => (a.firstTime < b.firstTime ? -1 : 1))
              return (
                <div key={s.id} className={`border-l-2 px-3 py-1.5 ${sessSel ? 'border-[#4fc1ff] bg-[#4fc1ff1f]' : 'border-transparent hover:bg-[#2d2d30]'}`}>
                  <div className="cursor-pointer text-[12.5px] text-[#e8e8e8]" onClick={() => toggleTree(s.id)}>
                    <span className="mr-1.5 text-[9px] text-muted-foreground">{open ? '▾' : '▸'}</span>
                    {s.title}
                    {ms.length > 0 && (
                      <span className="ml-1.5 text-[10px] text-muted-foreground">
                        · {ms.length} 里程碑 · {snapshot.chapters.filter((c) => c.session === s.id && !c.superseded).length} 章
                      </span>
                    )}
                  </div>
                  {open && (
                    <div className="ml-3.5 border-l border-border pl-1.5">
                      {ms.map((m) => {
                        const msKey = `${s.id}/${m.id}`
                        // Owner ruling: milestone chapters default COLLAPSED; clicking the card expands (and selects).
                        const mOpen = treeMsOpen[msKey] ?? false
                        const mSel = selection.level === 'milestone' && selection.mid === m.id
                        const colorIdx = msOrder.findIndex((x) => x.id === m.id) % MS_COLORS.length
                        return (
                          <div key={m.id} className="my-1">
                            <div
                              className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1 ${mSel ? 'border-[#4fc1ff] bg-[#4fc1ff1f]' : 'border-border bg-[#2d2d30] hover:border-[#6b6b6b]'}`}
                              onClick={() => {
                                toggleTreeMs(msKey)
                                onSelect({ level: 'milestone', sid: s.id, mid: m.id })
                              }}
                            >
                              <span className="text-[9px] text-muted-foreground">{mOpen ? '▾' : '▸'}</span>
                              <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: MS_COLORS[colorIdx] }} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11.5px] text-[#e8e8e8]">{m.title}</span>
                                <span className="block text-[9.5px] text-muted-foreground">
                                  Ch.{m.chapterIndexes[0]}–{m.chapterIndexes.at(-1)} · {m.chapterIndexes.length} 章
                                </span>
                              </span>
                            </div>
                            {mOpen &&
                              snapshot.chapters
                                .filter((c) => c.session === s.id && !c.superseded && m.chapterIndexes.includes(c.index))
                                .sort((a, b) => a.index - b.index)
                                .map((c) => {
                                  const chSel = selection.level === 'chapter' && selection.sid === s.id && selection.chapter === c.index
                                  return (
                                    <div
                                      key={c.index}
                                      className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 pl-5 text-[11px] ${chSel ? 'bg-[#4fc1ff24]' : 'hover:bg-[#2d2d30]'}`}
                                      onClick={() => onSelect({ level: 'chapter', sid: s.id, chapter: c.index })}
                                    >
                                      <span className="w-8 flex-none text-[10px] text-muted-foreground">Ch.{c.index}</span>
                                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                                      <span className={`text-[9.5px] ${c.verified ? 'text-green-500' : 'text-muted-foreground'}`}>{c.verified ? '✓' : '○'}</span>
                                    </div>
                                  )
                                })}
                          </div>
                        )
                      })}
                      {ms.length === 0 && <div className="px-1.5 py-1 text-[11px] text-muted-foreground">（无里程碑）</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {sidebarView === 'pits' && (
          <RoadmapPitsView
            sections={pitsData.pitSections}
            onOpenSource={(href) => {
              if (worktreeId) {
                useAppStore.getState().openRoadmapCanvas(worktreeId)
              }
              void href
            }}
          />
        )}
      </div>
    </div>
  )
}
