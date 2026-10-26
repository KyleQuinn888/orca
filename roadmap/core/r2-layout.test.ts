// r2-layout + r2-selection tests — spec §2.2-2.3 (geometry) and §3 (identity).

import { describe, expect, test } from 'bun:test'
import { buildSnapshot, type FileMap } from './r2-snapshot'
import { deriveRelations } from './r2-chains'
import { computeLayout } from './r2-layout'
import { PROJECT, reResolve } from './r2-selection'

function snap2(): FileMap {
  const f: FileMap = new Map()
  const I = (p: string, front: string) => f.set(p, `---\n${front}\n---\n`)
  I('INDEX.md', "sessions: 2\nmilestones: 2\nchapters: 3\ngeneratedAt: '2026-10-25T16:41:26.836Z'")
  I('001/sA/000-index.md', "session: sA\ntitle: A\nworkspace: 'C:/ws'\ntime:\n  firstTime: '2026-10-01T00:00:00Z'\n  lastTime: '2026-10-03T00:00:00Z'")
  I('001/sA/001-a.md', "title: A\ntime:\n  firstTime: '2026-10-01T00:00:00Z'\n  lastTime: '2026-10-01T12:00:00Z'\nquality: draft")
  I('001/sA/002-b.md', "title: A\ntime:\n  firstTime: '2026-10-02T00:00:00Z'\n  lastTime: '2026-10-03T00:00:00Z'\nquality: draft")
  I('001/sB/000-index.md', "session: sB\ntitle: B\nworkspace: 'C:/ws'\ntime:\n  firstTime: '2026-10-04T00:00:00Z'\n  lastTime: '2026-10-04T06:00:00Z'")
  I('001/sB/003-c.md', "title: B\ntime:\n  firstTime: '2026-10-04T00:00:00Z'\n  lastTime: '2026-10-04T06:00:00Z'\nquality: draft")
  f.set('002/m-1.md', "---\nid: m1\ntitle: M1\nsessions:\n  - session: sA\n    chapters: [1, 2]\ntime:\n  firstTime: '2026-10-01T00:00:00Z'\n  lastTime: '2026-10-03T00:00:00Z'\nquality: draft\n---\n")
  f.set('002/m-2.md', "---\nid: m2\ntitle: M2\nsessions:\n  - session: sB\n    chapters: [3]\ntime:\n  firstTime: '2026-10-04T00:00:00Z'\n  lastTime: '2026-10-04T06:00:00Z'\nquality: draft\n---\n")
  return f
}

describe('computeLayout', () => {
  const snap = buildSnapshot(snap2()).snapshot!
  const rel = deriveRelations(snap)

  test('blocks: clamp keeps true endpoint; corridor left of all blocks', () => {
    const L = computeLayout(snap, rel, { dayPx: 32 })
    const a = L.blocks.find((b) => b.sid === 'sA')!
    const b = L.blocks.find((b) => b.sid === 'sB')!
    expect(a.w).toBeGreaterThan(a.trueEndX - a.x)
    expect(b.trueEndX - b.x).toBeCloseTo(0.25 * 32, 1)
    expect(L.corridorX).toBe(Math.max(0, Math.min(a.x, b.x) - 14))
    expect(L.blocks.map((x) => x.sid)).toEqual(['sA', 'sB'])
  })

  test('expanded block: rows per milestone, crowded cells shift right without overlap', () => {
    const L = computeLayout(snap, rel, { dayPx: 8, minCellW: 12, expandedSid: 'sA' })
    const a = L.blocks.find((b) => b.sid === 'sA')!
    expect(a.expanded).toBe(true)
    expect(a.rows).toHaveLength(1)
    const cells = a.rows[0].cells
    expect(cells.map((c) => c.chapter)).toEqual([1, 2])
    let right = -Infinity
    for (const c of cells) {
      expect(c.left).toBeGreaterThanOrEqual(right + 1)
      right = c.left + c.width
    }
    expect(cells.some((c) => c.shifted)).toBe(true)
    expect(a.h).toBeGreaterThan(L.blocks.find((x) => x.sid === 'sB')!.h)
    expect(L.laneTops.sB).toBe(L.laneTops.sA + L.laneHeights.sA)
  })

  test('fitDayPx maps span to canvas width', () => {
    const L = computeLayout(snap, rel, { dayPx: 32 })
    const spanDays = (L.t1 - L.t0) / 86400000
    expect(L.fitDayPx(1000)).toBeCloseTo(1000 / spanDays, 5)
  })
})

describe('milestone ordering', () => {
  function reversed(): FileMap {
    // m-aaa.md enumerates FIRST (alphabetical) but starts LATER; m-zzz starts earlier.
    const f: FileMap = new Map()
    const I = (p2: string, front: string) => f.set(p2, `---\n${front}\n---\n`)
    I('INDEX.md', `sessions: 1
milestones: 2
chapters: 2
generatedAt: '2026-10-25T16:41:26.836Z'`)
    I('001/sA/000-index.md', `session: sA
title: A
workspace: 'C:/ws'
time:
  firstTime: '2026-10-01T00:00:00Z'
  lastTime: '2026-10-04T00:00:00Z'`)
    I('001/sA/001-a.md', `title: A
time:
  firstTime: '2026-10-01T00:00:00Z'
  lastTime: '2026-10-02T00:00:00Z'
quality: draft`)
    I('001/sA/002-b.md', `title: A
time:
  firstTime: '2026-10-02T00:00:00Z'
  lastTime: '2026-10-04T00:00:00Z'
quality: draft`)
    f.set('002/m-aaa.md', `---
id: mA
title: late
sessions:
  - session: sA
    chapters: [2]
time:
  firstTime: '2026-10-02T00:00:00Z'
  lastTime: '2026-10-04T00:00:00Z'
quality: draft
---
`)
    f.set('002/m-zzz.md', `---
id: mZ
title: early
sessions:
  - session: sA
    chapters: [1]
time:
  firstTime: '2026-10-01T00:00:00Z'
  lastTime: '2026-10-02T00:00:00Z'
quality: draft
---
`)
    return f
  }

  test('snapshot and band segments are time-ordered despite ULID file order', () => {
    const snap = buildSnapshot(reversed()).snapshot!
    expect(snap.milestones.map((m) => m.id)).toEqual(['mZ', 'mA'])
    const L = computeLayout(snap, deriveRelations(snap), { dayPx: 32 })
    const a = L.blocks.find((b) => b.sid === 'sA')!
    expect(a.segments.map((x) => x.mid)).toEqual(['mZ', 'mA'])
    expect(a.segments[0].startMs).toBeLessThan(a.segments[1].startMs)
    // the snapshot array handed to computeLayout unsorted also comes out sorted (defense)
    const shuffled = { ...snap, milestones: [...snap.milestones].reverse() }
    const L2 = computeLayout(shuffled as typeof snap, deriveRelations(snap), { dayPx: 32 })
    expect(L2.blocks[0].segments.map((x) => x.mid)).toEqual(['mZ', 'mA'])
  })
})

describe('reResolve', () => {
  const snap = buildSnapshot(snap2()).snapshot!
  const evolved = buildSnapshot(snap2()).snapshot!
  evolved.milestones = snap.milestones.filter((m) => m.id !== 'm2')

  test('chapter survives; milestone re-key demotes to session; dead session -> project', () => {
    expect(reResolve({ level: 'chapter', sid: 'sA', chapter: 2 }, evolved)).toEqual({
      sel: { level: 'chapter', sid: 'sA', chapter: 2 },
      demoted: false
    })
    const ms = reResolve({ level: 'milestone', sid: 'sB', mid: 'm2' }, evolved)
    expect(ms).toEqual({ sel: { level: 'session', sid: 'sB' }, demoted: true })
    expect(reResolve({ level: 'session', sid: 'gone' }, evolved)).toEqual({ sel: PROJECT, demoted: true })
    expect(reResolve(PROJECT, evolved).demoted).toBe(false)
  })
})
