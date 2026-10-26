// Canvas inspector (right 300px): detail for project / session / milestone /
// chapter selections (spec r2-ui.md v1.2 §3).

import type { R2Snapshot } from '../../../../../roadmap/core/r2-snapshot'
import { milestoneLabel } from '../../../../../roadmap/core/r2-snapshot'
import type { Selection } from '../../../../../roadmap/core/r2-selection'
import { MS_COLORS } from './CanvasTimeline'

const DAY = 86400000

function fmt(ms: number): string {
  if (Number.isNaN(ms)) {
    return '—'
  }
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function gapText(a: string, b: string): string {
  const gap = Date.parse(b) - Date.parse(a)
  if (Number.isNaN(gap) || gap < 0) {
    return ''
  }
  return `${Math.floor(gap / DAY)} 天 ${Math.floor((gap % DAY) / 3600000)} 小时`
}

export function CanvasInspector({
  snapshot,
  selection,
  onSelect,
  onOpenChapter
}: {
  snapshot: R2Snapshot
  selection: Selection
  onSelect: (sel: Selection) => void
  onOpenChapter: (file: string) => void
}): React.JSX.Element {
  const colorOf = (mid: string): string => {
    const order = [...snapshot.milestones].sort((a, b) => (a.firstTime < b.firstTime ? -1 : 1))
    return MS_COLORS[order.findIndex((m) => m.id === mid) % MS_COLORS.length] ?? '#8b949e'
  }

  if (selection.level === 'project') {
    return (
      <div className="text-[12px]">
        <h3 className="mb-2 text-[12.5px] font-semibold text-[#e8e8e8]">项目传记</h3>
        <InsRow k="会话" v={`${snapshot.sessions.length}`} />
        <InsRow k="章节" v={`${snapshot.chapters.filter((c) => !c.superseded).length}`} />
        <InsRow k="里程碑" v={`${snapshot.milestones.length}`} />
        <InsRow k="坑" v={`${snapshot.pitCount}`} />
        <div className="mt-2 text-[11.5px] text-muted-foreground">选中画布对象查看详情。</div>
      </div>
    )
  }

  const sess = snapshot.sessions.find((s) => s.id === selection.sid)
  if (!sess) {
    return <div className="text-[11.5px] text-muted-foreground">—</div>
  }

  if (selection.level === 'session') {
    return (
      <div className="text-[12px]">
        <h3 className="mb-2 text-[12.5px] font-semibold text-[#e8e8e8]">{sess.title}</h3>
        <InsRow k="时间" v={`${fmt(Date.parse(sess.firstTime))} → ${fmt(Date.parse(sess.lastTime))}`} />
        <InsRow k="章" v={`${snapshot.chapters.filter((c) => c.session === sess.id && !c.superseded).length}`} />
        <InsRow k="已验" v={`${snapshot.chapters.filter((c) => c.session === sess.id && !c.superseded && c.verified).length}`} />
        {snapshot.milestones
          .filter((m) => m.session === sess.id)
          .sort((a, b) => (a.firstTime < b.firstTime ? -1 : 1))
          .map((m) => (
            <div
              key={m.id}
              className="my-2 cursor-pointer rounded border border-border p-2 hover:border-[#6b6b6b]"
              onClick={() => onSelect({ level: 'milestone', sid: sess.id, mid: m.id })}
            >
              <div className="flex items-center gap-1.5 text-[11.5px] text-[#e8e8e8]">
                <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: colorOf(m.id) }} />
                {m.title}
              </div>
              <div className="text-[10px] text-muted-foreground">{milestoneLabel(snapshot, m.id)} · Ch.{m.chapterIndexes[0]}–{m.chapterIndexes.at(-1)}</div>
            </div>
          ))}
      </div>
    )
  }

  if (selection.level === 'milestone') {
    const m = snapshot.milestones.find((x) => x.id === selection.mid)
    if (!m) {
      return <div className="text-[11.5px] text-muted-foreground">里程碑已重组 — 选择已降级</div>
    }
    return (
      <div className="text-[12px]">
        <h3 className="mb-2 text-[12.5px] font-semibold text-[#e8e8e8]">{m.title}</h3>
        <InsRow k="里程碑" v={`${milestoneLabel(snapshot, m.id)} · Ch.${m.chapterIndexes[0]}–${m.chapterIndexes.at(-1)}`} />
        <InsRow k="信号" v={m.signal} />
        <InsRow k="时间" v={`${fmt(Date.parse(m.firstTime))} → ${fmt(Date.parse(m.lastTime))}`} />
        <InsRow k="会话" v={sess.title} />
        <div className="mt-2 text-[10.5px] text-muted-foreground">章节</div>
        {snapshot.chapters
          .filter((c) => c.session === sess.id && !c.superseded && m.chapterIndexes.includes(c.index))
          .sort((a, b) => a.index - b.index)
          .map((c) => (
            <div key={c.index} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] hover:bg-[#2d2d30]" onClick={() => onSelect({ level: 'chapter', sid: sess.id, chapter: c.index })}>
              <span className="w-9 text-muted-foreground">Ch.{c.index}</span>
              <span className="flex-1 truncate">{c.title}</span>
              <span className={c.verified ? 'text-green-500' : 'text-muted-foreground'}>{c.verified ? '✓' : '○'}</span>
            </div>
          ))}
        <button className="mt-2 rounded border border-border px-2 py-0.5 text-[11px]" onClick={() => onSelect({ level: 'session', sid: sess.id })}>← 返回会话</button>
      </div>
    )
  }

  const c = snapshot.chapters.find((x) => x.session === sess.id && x.index === selection.chapter)
  if (!c) {
    return <div className="text-[11.5px] text-muted-foreground">章已重组 — 选择已降级</div>
  }
  const m = snapshot.milestones.find((x) => x.session === sess.id && x.chapterIndexes.includes(c.index))
  return (
    <div className="text-[12px]">
      <h3 className="mb-2 text-[12.5px] font-semibold text-[#e8e8e8]">Ch.{c.index} {c.title}</h3>
      <InsRow k="里程碑" v={m ? `${milestoneLabel(snapshot, m.id)} ${m.title}` : '—'} />
      <InsRow k="会话" v={sess.title} />
      <InsRow k="时间" v={`${fmt(Date.parse(c.firstTime))} → ${fmt(Date.parse(c.lastTime))}`} />
      <InsRow k="时长" v={gapText(c.firstTime, c.lastTime)} />
      <InsRow k="状态" v={c.verified ? '✓ 锚点已验' : '○ 锚点未验'} />
      <button className="mt-2 rounded border border-[#4fc1ff] px-2 py-0.5 text-[11px] text-[#4fc1ff]" onClick={() => onOpenChapter(c.file)}>打开章卡 ›</button>
      {m && <button className="mt-2 ml-2 rounded border border-border px-2 py-0.5 text-[11px]" onClick={() => onSelect({ level: 'milestone', sid: sess.id, mid: m.id })}>← 里程碑</button>}
    </div>
  )
}

function InsRow({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-0.5 text-[11.5px]">
      <span className="w-14 flex-none text-muted-foreground">{k}</span>
      <span className="min-w-0 break-words">{v}</span>
    </div>
  )
}
