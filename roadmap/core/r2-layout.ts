// R2 canvas geometry — spec r2-ui.md v1.2 §2.2-2.5. Pure math; the React view
// renders this model 1:1 (mockup r2-canvas-claude.html is the visual baseline).

import type { R2Snapshot } from './r2-snapshot'
import type { Relations } from './r2-chains'

export type LayoutOpts = {
  dayPx: number
  minBlockW: number
  minCellW: number
  collapsedH: number
  expandedBaseH: number
  rowH: number
  lanePad: number
  expandedSid: string | null
}

export const DEFAULT_OPTS: LayoutOpts = {
  dayPx: 32,
  minBlockW: 150,
  minCellW: 12,
  collapsedH: 84,
  expandedBaseH: 94,
  rowH: 17,
  lanePad: 22,
  expandedSid: null
}

export type MsSegment = { mid: string; startMs: number; endMs: number }

export type ChapterCell = { chapter: number; left: number; width: number; verified: boolean; shifted: boolean }

export type BlockRow = { mid: string; cells: ChapterCell[] }

export type BlockLayout = {
  sid: string
  x: number
  w: number
  trueEndX: number
  h: number
  expanded: boolean
  segments: MsSegment[]
  rows: BlockRow[]
}

export type Layout = {
  t0: number
  t1: number
  widthPx: number
  laneTops: Record<string, number>
  laneHeights: Record<string, number>
  blocks: BlockLayout[]
  corridorX: number
  bands: { startMs: number; endMs: number; sessions: string[] }[]
  fitDayPx: (canvasWidth: number) => number
}

const ms = (s: string) => Date.parse(s)

export function computeLayout(snap: R2Snapshot, rel: Relations, optsIn?: Partial<LayoutOpts>): Layout {
  const o = { ...DEFAULT_OPTS, ...optsIn }
  const timed = snap.sessions.filter((s) => !Number.isNaN(ms(s.firstTime)) && !Number.isNaN(ms(s.lastTime)))
  const ordered = [...timed].sort((a, b) => ms(a.firstTime) - ms(b.firstTime))
  // 1h (not 1 day) left pad: horizontal space is the scarce axis — blocks hug the left edge
  const t0 = ordered.length ? Math.min(...ordered.map((s) => ms(s.firstTime))) - 3600000 : 0
  const t1 = ordered.length ? Math.max(...ordered.map((s) => ms(s.lastTime))) + 86400000 : 1
  const x = (t: number) => ((t - t0) / 86400000) * o.dayPx

  const blocks: BlockLayout[] = []
  for (const s of ordered) {
    const sx = x(ms(s.firstTime))
    const trueEndX = x(ms(s.lastTime))
    const w = Math.max(trueEndX - sx, o.minBlockW)
    const expanded = o.expandedSid === s.id
    const segs: MsSegment[] = snap.milestones
      .filter((m) => m.session === s.id)
      .map((m) => ({ mid: m.id, startMs: ms(m.firstTime), endMs: ms(m.lastTime) }))
      // defense-in-depth: band segments and drill rows must be time-ordered even if
      // a caller hand-builds an unsorted snapshot
      .sort((a, b) => a.startMs - b.startMs)
    const rows: BlockRow[] = []
    if (expanded) {
      for (const seg of segs) {
        const cells: ChapterCell[] = []
        let prevRight = -Infinity
        for (const c of snap.chapters.filter((c) => c.session === s.id && !c.superseded && seg.mid === milestoneOf(snap, s.id, c.index))) {
          const rawL = x(ms(c.firstTime)) - sx
          const rawW = Math.max(x(ms(c.lastTime)) - x(ms(c.firstTime)), o.minCellW)
          const left = Math.max(rawL, prevRight + 1)
          cells.push({ chapter: c.index, left, width: rawW, verified: c.verified, shifted: left > rawL + 0.5 })
          prevRight = left + rawW
        }
        rows.push({ mid: seg.mid, cells })
      }
    }
    const h = expanded ? o.expandedBaseH + rows.length * o.rowH : o.collapsedH
    blocks.push({ sid: s.id, x: sx, w, trueEndX, h, expanded, segments: segs, rows })
  }

  const laneTops: Record<string, number> = {}
  const laneHeights: Record<string, number> = {}
  let top = 0
  for (const b of blocks) {
    laneTops[b.sid] = top
    laneHeights[b.sid] = b.h + o.lanePad
    top += b.h + o.lanePad
  }

  const minBlockX = blocks.length ? Math.min(...blocks.map((b) => b.x)) : 0
  return {
    t0,
    t1,
    widthPx: x(t1),
    laneTops,
    laneHeights,
    blocks,
    corridorX: Math.max(0, minBlockX - 14),
    bands: rel.bands,
    fitDayPx: (canvasWidth: number) => (t1 > t0 ? (canvasWidth / (t1 - t0)) * 86400000 : o.dayPx)
  }
}

function milestoneOf(snap: R2Snapshot, sid: string, chapterIdx: number): string {
  const m = snap.milestones.find(
    (m) => m.session === sid && m.chapterIndexes.some((n) => n === chapterIdx)
  )
  return m ? m.id : ''
}
