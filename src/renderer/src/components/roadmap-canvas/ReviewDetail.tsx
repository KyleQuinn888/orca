// Full review surface (canvas bottom panel, review mode) — Codex-informed
// structure: pinned decision header -> before/after grouping rails (never
// truncated) -> per-cut rationale + adjacent-chapter narrative -> sticky footer.

import type { R2InboxGroup, R2Snapshot } from '../../../../../roadmap/core/r2-snapshot'
import { milestoneLabel } from '../../../../../roadmap/core/r2-snapshot'
import { consequenceOf } from '../../../../../roadmap/core/r2-review'

export function ReviewDetail({
  snapshot,
  group,
  onDone,
  onApprove,
  onReject,
  phase,
  errMsg
}: {
  snapshot: R2Snapshot
  group: R2InboxGroup
  onDone: () => void
  onApprove: () => void
  onReject: () => void
  phase?: 'confirming' | 'writing' | 'error'
  errMsg?: string
}): React.JSX.Element {
  const cons = consequenceOf(snapshot, group)
  const session = snapshot.sessions.find((s) => s.id === group.session)
  const titleOf = (mid: string): string => snapshot.milestones.find((m) => m.id === mid)?.title ?? ''
  const newRows = cons.after.filter((r) => r.isNew).length

  return (
    <div className="flex h-full flex-col text-[12px]">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-1.5">
        <span className="text-[#d29922]">◇ 审查提议</span>
        <span className="text-[#e8e8e8]">{session?.title ?? group.session}</span>
        <span className="text-muted-foreground">
          {group.cuts.length} 个切点 · Ch.{Math.min(...group.cuts.map((c) => c.chapter))}–Ch.
          {cons.after.at(-1)?.chapterTo ?? '?'} · {group.by} · {group.at.slice(0, 16).replace('T', ' ')}
        </span>
        <button className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground" onClick={onDone}>
          关闭 ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-4 py-2">
        {/* before/after rails — titles wrap, never truncate */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10.5px] text-muted-foreground">当前分段</div>
            {cons.before.map((r) => (
              <div key={r.mid} className="mb-1 rounded border border-border bg-[#2d2d30] px-2 py-1">
                <div className="flex gap-1.5">
                  <span className="font-semibold text-[#4fc1ff]">{r.label}</span>
                  <span className="text-muted-foreground">Ch.{r.chapterFrom}–{r.chapterTo}</span>
                </div>
                <div className="text-[11px] leading-snug text-[#e8e8e8]">{titleOf(r.mid)}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 text-[10.5px] text-muted-foreground">批准后分段</div>
            {cons.after.map((r, i) => (
              <div
                key={`${r.label}-${i}`}
                className={`mb-1 rounded border px-2 py-1 ${r.isNew ? 'border-[#d29922] bg-[#d299220d]' : 'border-border bg-[#2d2d30]'}`}
              >
                <div className="flex gap-1.5">
                  <span className={`font-semibold ${r.isNew ? 'text-[#d29922]' : 'text-[#4fc1ff]'}`}>
                    {r.isNew ? r.label : milestoneLabel(snapshot, r.mid)}
                  </span>
                  <span className="text-muted-foreground">Ch.{r.chapterFrom}–{r.chapterTo}</span>
                  {r.isNew && <span className="text-[10px] text-[#d29922]">新</span>}
                </div>
                <div className="text-[11px] leading-snug text-[#e8e8e8]">{r.isNew ? '（切出后待命名）' : titleOf(r.mid)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* per-cut rationale + adjacent narrative (full wrap) */}
        {group.cuts.map((c) => {
          const prev = snapshot.chapters.find((x) => x.session === group.session && !x.superseded && x.index === c.chapter - 1)
          const next = snapshot.chapters.find((x) => x.session === group.session && !x.superseded && x.index === c.chapter)
          return (
            <div key={c.chapter} className="mt-2 border-t border-border pt-2">
              <div className="font-semibold text-[#d29922]">Ch.{c.chapter} 前</div>
              <div className="text-[11.5px] leading-relaxed text-[#c8c8c8]">{c.evidence}</div>
              {(prev || next) && (
                <div className="mt-1 ml-2 border-l-2 border-[#4b4b4b] pl-2">
                  {prev && (
                    <div className="text-[11px] leading-snug">
                      <span className="text-muted-foreground">▸ 前段收止 Ch.{prev.index}：</span>
                      <span className="text-[#e8e8e8]">{prev.title}</span>
                      {prev.summary && <div className="pl-4 text-muted-foreground">{prev.summary}</div>}
                    </div>
                  )}
                  {next && (
                    <div className="text-[11px] leading-snug">
                      <span className="text-muted-foreground">▸ 后段开启 Ch.{next.index}：</span>
                      <span className="text-[#e8e8e8]">{next.title}</span>
                      {next.summary && <div className="pl-4 text-muted-foreground">{next.summary}</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* sticky footer */}
      <div className="flex items-center gap-2 border-t border-border px-4 py-2">
        <span className="text-[11px] text-muted-foreground">
          后果：{newRows > 0 ? `切出 ${newRows} 个新分段` : '重排分段'}；记录 user review 后等待重聚合。
        </span>
        {phase === 'writing' && <span className="text-[11px] text-[#4fc1ff]">排队/写入中…</span>}
        {phase === 'error' && <span className="text-[11px] text-[#f0883e]">失败：{errMsg}</span>}
        <div className="ml-auto flex gap-2">
          <button className="rounded border border-border px-3 py-1 text-[11.5px]" disabled={phase === 'writing'} onClick={onReject}>
            拒绝
          </button>
          <button
            className="rounded bg-[#4fc1ff] px-3 py-1 text-[11.5px] font-semibold text-[#1e1e1e] disabled:opacity-50"
            disabled={phase === 'writing'}
            onClick={onApprove}
          >
            确认批准
          </button>
        </div>
      </div>
    </div>
  )
}
