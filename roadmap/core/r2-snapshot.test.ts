// R2 UI core tests — spec r2-ui.md v1.2 §2.4/§2.6/§4.

import { describe, expect, test } from 'bun:test'
import { buildSnapshot, milestoneLabel, type FileMap } from './r2-snapshot'
import { attachForks, deriveRelations } from './r2-chains'

function fixture(): FileMap {
  const f: FileMap = new Map()
  const I = (p: string, front: string, body = '') => f.set(p, `---\n${front}\n---\n${body}`)
  I('INDEX.md', `v: 1\nkind: roadmap-index\nsessions: 2\nmilestones: 1\nchapters: 3\ngeneratedAt: '2026-10-25T16:41:26.836Z'`)
  I('001/sA/000-index.md', [
    "session: sA", "title: 推进 A", "workspace: 'C:/ws/paperB'",
    "time:", "  firstTime: '2026-10-03T13:28:15.325Z'", "  lastTime: '2026-10-10T05:55:26.123Z'"
  ].join('\n'))
  I('001/sA/001-旧版.superseded.md', [
    "title: 推进 A", "time:", "  firstTime: '2026-10-03T13:28:15.325Z'", "  lastTime: '2026-10-03T16:40:59.416Z'", 'quality: draft'
  ].join('\n'))
  for (const [n, verified, last] of [['001', true, '16:40'], ['002', false, '10-04T06:43'], ['003', true, '10-10T05:55']] as const) {
    I(`001/sA/${n}-章.md`, [
      `title: 推进 A`, 'time:', `  firstTime: '2026-10-${n === '001' ? '03T13:28' : n === '002' ? '03T16:44' : '10-04T06:46'}:00.000Z'`,
      `  lastTime: '2026-${last}:00.000Z'`, ...(verified ? ['anchorsVerifiedAt: 2026-10-25T00:43:15.456Z'] : []), 'quality: draft'
    ].join('\n'))
  }
  I('001/sB/000-index.md', [
    "session: sB", "title: 预演 B", "workspace: 'C:/ws/paperB'",
    "time:", "  firstTime: '2026-10-11T09:12:00.000Z'", "  lastTime: '2026-10-12T17:40:00.000Z'"
  ].join('\n'))
  f.set('002/m-live.md', [
    '---', 'id: m-live', 'title: 活动里程碑', 'boundary:', '  signal: llm-cut',
    'sessions:', "  - session: sA", '    chapters: [1, 2, 3]', "    chapterSlugs:", '      - 章', '      - 章', '      - 章',
    'time:', "  firstTime: '2026-10-03T13:28:15.325Z'", "  lastTime: '2026-10-10T05:55:26.123Z'",
    'quality: draft', '---', ''
  ].join('\n'))
  f.set('002/m-old.md', '---\nid: m-old\ntitle: 旧组\nsessions:\n  - session: sA\n    chapters: [1, 2]\ntime:\n  firstTime: a\n  lastTime: b\nquality: superseded\n---\n')
  f.set('002/boundaries.json', JSON.stringify({
    version: 1,
    events: [
      { id: 'mk-1', op: 'add-cut', at: '2026-10-25T16:38:41.192Z', session: 'sB', anchor: { chapter: 2 }, by: 'llm', proposalGroupId: 'pg-open', evidence: '切前证据' },
      { id: 'mk-2', op: 'add-cut', at: '2026-10-24T16:38:41.192Z', session: 'sB', anchor: { chapter: 4 }, by: 'llm', proposalGroupId: 'pg-done', evidence: '已处理' },
      { id: 'mk-3', op: 'promote', at: '2026-10-25T17:00:00.000Z', session: 'sB', by: 'system', target: { proposalGroupId: 'pg-done' } }
    ]
  }))
  f.set('pits/DETAILS.md', '| <!-- pit-aaaaaa --> k | s | c | 未验 |\n| <!-- pit-aaaaaa --> k2 | s2 | c | ✓ |\n| <!-- pit-bbbbbb --> k | s | c | 未验 |\n')
  return f
}

describe('buildSnapshot', () => {
  test('parses generation-consistent snapshot', () => {
    const r = buildSnapshot(fixture())
    expect(r.ok).toBe(true)
    const s = r.snapshot!
    expect(s.generation).toBe('2026-10-25T16:41:26.836Z')
    expect(s.sessions).toHaveLength(2)
    expect(s.milestones).toHaveLength(1) // draft only, superseded excluded
    expect(s.milestones[0].chapterIndexes).toEqual([1, 2, 3])
    expect(s.chapters.filter((c) => !c.superseded)).toHaveLength(3)
    expect(s.chapters.find((c) => c.index === 1 && !c.superseded)?.verified).toBe(true)
    expect(s.chapters.find((c) => c.index === 2 && !c.superseded)?.verified).toBe(false)
    expect(s.pitCount).toBe(2) // unique pit-ids
    expect(milestoneLabel(s, 'm-live')).toBe('M1')
  })

  test('inbox: unresolved group open, promoted group resolved', () => {
    const s = buildSnapshot(fixture()).snapshot!
    expect(s.inbox).toHaveLength(1)
    expect(s.inbox[0].proposalGroupId).toBe('pg-open')
    expect(s.inbox[0].cuts).toEqual([{ chapter: 2, evidence: '切前证据' }])
    expect(s.inbox[0].state).toBe('pending')
  })

  test('generation mismatch: chapter count drift rejected', () => {
    const f = fixture()
    f.set('INDEX.md', f.get('INDEX.md')!.replace('chapters: 3', 'chapters: 5'))
    const r = buildSnapshot(f)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('generation-mismatch')
  })

  test('generation mismatch: milestones claimed but no draft m-cards', () => {
    const f = fixture()
    f.set('002/m-live.md', f.get('002/m-live.md')!.replace('quality: draft', 'quality: superseded'))
    expect(buildSnapshot(f).reason).toBe('generation-mismatch')
  })

  test('human review (approve/reject) resolves the group in the inbox', () => {
    const f = fixture()
    const before = JSON.parse(f.get('002/boundaries.json')!)
    before.events.push({
      id: 'mk-4',
      op: 'review',
      at: '2026-10-25T18:00:00.000Z',
      session: 'sB',
      by: 'user',
      reviewTarget: { proposalGroupId: 'pg-open' },
      decision: 'approve',
      reason: 'r2:inbox'
    })
    f.set('002/boundaries.json', JSON.stringify(before))
    expect(buildSnapshot(f).snapshot!.inbox).toHaveLength(0)
  })

  test('missing INDEX -> no-index', () => {
    const f = fixture()
    f.delete('INDEX.md')
    expect(buildSnapshot(f).reason).toBe('no-index')
  })
})

describe('deriveRelations', () => {
  const snap = buildSnapshot(fixture()).snapshot!

  test('continuation chain within 48h, same workspace', () => {
    const rel = deriveRelations(snap)
    // sA ends 10-10 05:55, sB starts 10-11 09:12 -> gap ~27h
    expect(rel.continuations).toHaveLength(1)
    expect(rel.continuations[0]).toMatchObject({ from: 'sA', to: 'sB', inferred: true })
    expect(rel.chains).toEqual([{ members: ['sA', 'sB'] }])
  })

  test('far sessions never link', () => {
    const f = fixture()
    f.set('001/sB/000-index.md', f.get('001/sB/000-index.md')!.replace('2026-10-11T09:12', '2026-10-30T09:12'))
    const s = buildSnapshot(f).snapshot!
    expect(deriveRelations(s).continuations).toHaveLength(0)
  })

  test('overlap band from time intersection', () => {
    const f = fixture()
    f.set('001/sB/000-index.md', f.get('001/sB/000-index.md')!.replace('2026-10-11T09:12', '2026-10-10T04:00').replace('2026-10-12T17:40', '2026-10-13T17:40'))
    const s = buildSnapshot(f).snapshot!
    const rel = deriveRelations(s)
    expect(rel.bands).toHaveLength(1)
    expect(rel.bands[0].sessions).toEqual(['sA', 'sB'])
  })

  test('arc spans head first-milestone start to tail end; fork gated off', () => {
    const rel = deriveRelations(snap)
    expect(rel.arcs).toHaveLength(1)
    expect(rel.arcs[0].id).toBe('sA>sB')
    expect(rel.arcs[0].fromMs).toBe(Date.parse('2026-10-03T13:28:15.325Z'))
    expect(rel.forks).toHaveLength(0)
    expect(rel.forkGate).toBe('lineage-unavailable')
    const opened = attachForks(rel, [{ from: 'sA', to: 'sB', basis: 'fixture' }])
    expect(opened.forkGate).toBe('open')
    expect(opened.forks).toHaveLength(1)
  })
})
