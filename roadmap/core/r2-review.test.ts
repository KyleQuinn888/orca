// consequence preview tests — spec §1.1 (approve confirm shows resulting grouping).

import { describe, expect, test } from 'bun:test'
import { buildSnapshot, type FileMap } from './r2-snapshot'
import { consequenceOf } from './r2-review'

function fx(): FileMap {
  const f: FileMap = new Map()
  const I = (p: string, front: string) => f.set(p, `---\n${front}\n---\n`)
  I('INDEX.md', "sessions: 1\nmilestones: 2\nchapters: 5\ngeneratedAt: '2026-10-25T16:41:26.836Z'")
  I('001/sA/000-index.md', "session: sA\ntitle: A\nworkspace: 'C:/ws'\ntime:\n  firstTime: '2026-10-01T00:00:00Z'\n  lastTime: '2026-10-05T00:00:00Z'")
  for (const n of [1, 2, 3, 4, 5]) {
    I(`001/sA/00${n}-c.md`, `title: A\ntime:\n  firstTime: '2026-10-0${n}T00:00:00Z'\n  lastTime: '2026-10-0${n}T12:00:00Z'\nquality: draft`)
  }
  f.set('002/m-1.md', "---\nid: m1\ntitle: 早期\nsessions:\n  - session: sA\n    chapters: [1, 2, 3]\ntime:\n  firstTime: '2026-10-01T00:00:00Z'\n  lastTime: '2026-10-03T12:00:00Z'\nquality: draft\n---\n")
  f.set('002/m-2.md', "---\nid: m2\ntitle: 晚期\nsessions:\n  - session: sA\n    chapters: [4, 5]\ntime:\n  firstTime: '2026-10-04T00:00:00Z'\n  lastTime: '2026-10-05T12:00:00Z'\nquality: draft\n---\n")
  f.set('002/boundaries.json', JSON.stringify({ version: 2, events: [
    { id: 'mk-01a', op: 'add-cut', at: '2026-10-26T10:00:00Z', session: 'sA', anchor: { chapter: 3 }, by: 'llm', proposalGroupId: 'pg-1', evidence: 'e1' }
  ] }))
  return f
}

test('before keeps current grouping; after splits at the cut', () => {
  const s = buildSnapshot(fx()).snapshot!
  const g = s.inbox.find((x) => x.proposalGroupId === 'pg-1')!
  const c = consequenceOf(s, g)
  expect(c.before.map((r) => `${r.label}:${r.chapterFrom}-${r.chapterTo}`)).toEqual(['M1:1-3', 'M2:4-5'])
  expect(c.after.map((r) => `${r.label}${r.isNew ? '*' : ''}:${r.chapterFrom}-${r.chapterTo}`)).toEqual(['M1:1-2', '新分段 1*:3-3', 'M3:4-5'])
  expect(c.after[1].replaces).toContain('m1')
})
