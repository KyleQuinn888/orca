// Canvas timeline: ruler + arc band + swimlanes with session blocks, milestone
// bands, chapter drill-down rows, relation wires and overlap bands. Pure render
// of the r2 core layout model (spec r2-ui.md v1.2 §2).

import { useMemo } from 'react'
import type { R2Snapshot } from '../../../../../roadmap/core/r2-snapshot'
import { milestoneLabel } from '../../../../../roadmap/core/r2-snapshot'
import type { Relations } from '../../../../../roadmap/core/r2-chains'
import { computeLayout } from '../../../../../roadmap/core/r2-layout'
import type { Selection } from '../../../../../roadmap/core/r2-selection'

export const MS_COLORS = ['#4fc1ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff', '#ff7b72', '#39c5cf', '#e3b341']

const DAY = 86400000

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  return `${fmtDate(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

type CanvasTimelineProps = {
  snapshot: R2Snapshot
  relations: Relations
  dayPx: number
  expandedSid: string | null
  selection: Selection
  onSelect: (sel: Selection) => void
  onToggleExpand: (sid: string | null) => void
}

export function CanvasTimeline({
  snapshot,
  relations,
  dayPx,
  expandedSid,
  selection,
  onSelect,
  onToggleExpand
}: CanvasTimelineProps): React.JSX.Element {
  const layout = useMemo(() => computeLayout(snapshot, relations, { dayPx, expandedSid }), [snapshot, relations, dayPx, expandedSid])
  const colorOf = useMemo(() => {
    const order = [...snapshot.milestones].sort((a, b) => (a.firstTime < b.firstTime ? -1 : 1))
    const map = new Map<string, string>()
    order.forEach((m, i) => map.set(m.id, MS_COLORS[i % MS_COLORS.length]))
    return (mid: string): string => map.get(mid) ?? '#8b949e'
  }, [snapshot])
  const xAt = (t: number): number => ((t - layout.t0) / DAY) * dayPx
  const sessionOf = (sid: string) => snapshot.sessions.find((s) => s.id === sid)
  const totalH = Object.values(layout.laneHeights).reduce((a, b) => a + b, 0)
  const totalW = layout.widthPx

  const rulerTicks: React.JSX.Element[] = []
  for (let t = layout.t0; t <= layout.t1; t += DAY) {
    const x = xAt(t)
    const d = new Date(t)
    rulerTicks.push(
      <span key={t} className="absolute top-[13px] border-l border-[#333] pl-1 text-[9px] text-[#6a6a6a]" style={{ left: x }}>
        {d.getDate()}
      </span>
    )
  }

  return (
    <div className="relative select-none" style={{ width: totalW, minWidth: totalW }}>
      {/* ruler */}
      <div className="relative h-[26px] border-b border-border">
        <span className="absolute top-0 border-l border-border pl-1 text-[10.5px] text-muted-foreground">
          {new Date(layout.t0).toLocaleDateString()}
        </span>
        {rulerTicks}
      </div>
      {/* arc band (chain-derived, v1) */}
      <div className="relative h-[26px] my-2">
        {relations.arcs.map((a) => (
          <div
            key={a.id}
            className="absolute top-1 h-4 rounded-full flex items-center px-3 text-[10.5px] font-semibold text-[#1e1e1e]"
            style={{ left: xAt(a.fromMs), width: Math.max(xAt(a.toMs) - xAt(a.fromMs), 4), background: '#3fb950cc' }}
            title={`弧轨道 · ${a.label}`}
          >
            弧 · {a.label}
          </div>
        ))}
      </div>
      {/* overlap bands */}
      {relations.bands.map((b, i) => (
        <div
          key={i}
          className="absolute border-x border-dashed border-[#58a6ff59] bg-[#58a6ff0f] z-0"
          style={{
            left: xAt(b.startMs),
            width: Math.max(xAt(b.endMs) - xAt(b.startMs), 2),
            top: layout.laneTops[b.sessions[0]] + 60,
            height: (layout.laneTops[b.sessions.at(-1) ?? ''] ?? 0) + 40 - (layout.laneTops[b.sessions[0]] + 60)
          }}
        >
          <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[9px] whitespace-nowrap text-[#58a6ff]">∥ 并行重叠</span>
        </div>
      ))}
      {/* lanes */}
      <div className="relative" style={{ height: totalH }}>
        {layout.blocks.map((blk) => {
          const sess = sessionOf(blk.sid)
          const selSid = selection.level !== 'project' ? selection.sid : null
          const isSel = selSid === blk.sid
          const title = sess?.title ?? blk.sid
          const chTotal = snapshot.chapters.filter((c) => c.session === blk.sid && !c.superseded).length
          return (
            <div key={blk.sid} className="absolute left-0 border-b border-[#2a2a2a]" style={{ top: layout.laneTops[blk.sid], width: totalW, height: layout.laneHeights[blk.sid] }}>
              <div className="absolute -left-[170px] top-6 w-[160px] text-right text-[10.5px] text-muted-foreground">
                <span className="block text-[11.5px] text-foreground">{fmtDate(Date.parse(sess?.firstTime ?? ''))} – {fmtDate(Date.parse(sess?.lastTime ?? ''))}</span>
              </div>
              <div
                className={`absolute top-[10px] rounded-md border bg-[#2d2d30] cursor-pointer overflow-hidden ${isSel ? 'border-[#4fc1ff] shadow-[0_0_0_1.5px_#4fc1ff]' : 'border-[#4b4b4b] hover:border-foreground'}`}
                style={{ left: blk.x, width: blk.w, height: blk.h }}
                onClick={() => onSelect({ level: 'session', sid: blk.sid })}
              >
                {snapshot.milestones.some((m) => m.session === blk.sid) && (
                  <button
                    className="absolute top-[3px] right-[4px] z-10 rounded border border-[#4b4b4b] bg-[#252526] px-1 text-[9px] text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleExpand(expandedSid === blk.sid ? null : blk.sid)
                    }}
                  >
                    {expandedSid === blk.sid ? '⌃' : '⌄ 章'}
                  </button>
                )}
                <div className="pt-[5px] pr-[40px] pl-2 text-[11.5px] font-semibold text-[#e8e8e8] truncate">{title}</div>
                <div className="px-2 text-[9.5px] text-muted-foreground truncate">
                  {chTotal} 章 · {snapshot.milestones.filter((m) => m.session === blk.sid).length} 里程碑
                </div>
                {blk.expanded && (
                  <div className="absolute left-[3px] right-[3px]" style={{ bottom: 20 }}>
                    {blk.rows.map((row) => (
                      <div key={row.mid} className="relative h-[17px] border-t border-dashed border-[#3a3a3a]" title={`${milestoneLabel(snapshot, row.mid)} ${snapshot.milestones.find((m) => m.id === row.mid)?.title ?? ''}`}>
                        {row.cells.map((c) => {
                          const chapSel = selection.level === 'chapter' && selection.sid === blk.sid && selection.chapter === c.chapter
                          return (
                            <div
                              key={c.chapter}
                              className={`absolute top-[1.5px] bottom-[1.5px] rounded-[2.5px] border-l-[2.5px] cursor-pointer flex items-center overflow-hidden whitespace-nowrap text-[8.5px] text-[#e8e8e8] ${c.verified ? 'bg-[#ffffff2b]' : 'bg-[#ffffff12] border-l-dashed'} ${chapSel ? 'outline outline-2 outline-[#4fc1ff] z-[3]' : 'hover:outline hover:outline-1.5 hover:outline-foreground'}`}
                              style={{ left: c.left, width: c.width, borderLeftColor: colorOf(row.mid) }}
                              title={`Ch.${c.chapter} · ${c.verified ? '锚点已验' : '锚点未验'}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                onSelect({ level: 'chapter', sid: blk.sid, chapter: c.chapter })
                              }}
                            >
                              {c.width >= 100 ? <span className="px-1 truncate">{c.chapter} {snapshot.chapters.find((ch) => ch.session === blk.sid && ch.index === c.chapter)?.title}</span> : c.width >= 14 ? c.chapter : ''}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
                {/* milestone band */}
                <div className="absolute left-1 right-1 bottom-1 h-3 flex gap-[1px]">
                  {blk.segments.map((seg) => {
                    const span = xAt(seg.endMs) - xAt(seg.startMs)
                    const total = xAt(Date.parse(sess?.lastTime ?? '')) - xAt(Date.parse(sess?.firstTime ?? ''))
                    const msSel = selection.level === 'milestone' && selection.mid === seg.mid
                    return (
                      <div
                        key={seg.mid}
                        className={`h-full rounded-[2px] min-w-2 flex items-center justify-center text-[8.5px] font-bold text-[#1e1e1e] cursor-pointer ${msSel ? 'outline outline-2 outline-[#4fc1ff]' : 'hover:outline hover:outline-1.5 hover:outline-foreground'}`}
                        style={{ width: `${Math.max((span / Math.max(total, 1)) * 100, 8)}%`, background: colorOf(seg.mid) }}
                        title={`${milestoneLabel(snapshot, seg.mid)} ${snapshot.milestones.find((m) => m.id === seg.mid)?.title ?? ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelect({ level: 'milestone', sid: blk.sid, mid: seg.mid })
                        }}
                      >
                        {milestoneLabel(snapshot, seg.mid)}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        })}
        {/* wires */}
        <svg className="absolute inset-0 pointer-events-none overflow-visible" width={totalW} height={totalH}>
          {relations.continuations.map((e) => {
            const from = layout.blocks.find((b) => b.sid === e.from)
            const to = layout.blocks.find((b) => b.sid === e.to)
            if (!from || !to) {
              return null
            }
            const y1 = (layout.laneTops[e.from] ?? 0) + from.h / 2 + 10
            const y2 = (layout.laneTops[e.to] ?? 0) + to.h / 2 + 10
            const x1 = from.trueEndX
            const x2 = to.x
            return (
              <g key={`${e.from}>${e.to}`}>
                <path d={`M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`} fill="none" stroke="#58a6ff" strokeWidth={1.5} strokeDasharray="5 4" />
                <text x={(x1 + x2) / 2 - 24} y={(y1 + y2) / 2 - 4} fill="#58a6ff" fontSize={9.5}>接续 · 推断</text>
              </g>
            )
          })}
        </svg>
      </div>
      {/* gap annotations between consecutive blocks */}
      {layout.blocks.slice(1).map((blk, i) => {
        const prev = layout.blocks[i]
        const gap = Date.parse(sessionOf(blk.sid)?.firstTime ?? '') - Date.parse(sessionOf(prev.sid)?.lastTime ?? '')
        if (Number.isNaN(gap) || gap <= 0) {
          return null
        }
        const days = Math.floor(gap / DAY)
        const hours = Math.floor((gap - days * DAY) / 3600000)
        return (
          <div key={`gap-${blk.sid}`} className="absolute text-[9.5px] text-muted-foreground" style={{ left: xAt(Date.parse(sessionOf(prev.sid)?.lastTime ?? '')) + 6, top: (layout.laneTops[prev.sid] ?? 0) + prev.h + 18 }}>
            ∶ 间隔 {days} 天 {hours} 小时
          </div>
        )
      })}
      <span className="hidden">{fmtDateTime(layout.t0)}</span>
    </div>
  )
}
