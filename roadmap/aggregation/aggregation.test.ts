// Tests for the v7.3 aggregation engine — spec layer-002-003 test list:
// replay stability / total-order replacement / suppress three-states / promote
// freeze / already-proposed guard / tail exception / corruption+restore /
// anchor lost / mixed-source single-chapter groups / attempt backoff /
// chapterSetHash v2 / atomic validation rules.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fold } from './fold'
import { loadChapters, chapterSetHash, positionOfSeq, type Chapter, type Signal } from './chapters'
import { evaluatePromotions, PROMOTION_DELAY_MS } from './promote'
import {
  attemptDigest,
  attemptEvent,
  proposalSpan,
  shouldAttempt,
  validateCuts,
  PROPOSAL_TRIGGER_CHAPTERS
} from './propose'
import { MarksStore, loadMarks, restoreFromBak, ulid, type MarkEvent } from './marks-store'
import { AggregateLock } from './aggregate-lock'

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeChapters(n: number, opts: { firstIndex?: number; skip?: number[] } = {}): Chapter[] {
  const first = opts.firstIndex ?? 1
  const out: Chapter[] = []
  for (let i = first; i < first + n; i++) {
    if (opts.skip?.includes(i)) {
      continue
    }
    out.push({
      file: `${String(i).padStart(3, '0')}-fixture.md`,
      index: i,
      heading: `Chapter ${i}`,
      slug: `chapter-${i}`,
      firstMsgSeq: i * 100,
      lastMsgSeq: i * 100 + 50,
      firstTime: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      lastTime: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
      versionHash: `hash${String(i).padStart(4, '0')}`,
      points: [`point of ${i}`],
      decisions: [`decision of ${i}`]
    })
  }
  return out
}

let clock = 0
function atTime(): string {
  clock += 60_000
  return new Date(Date.parse('2026-10-20T00:00:00Z') + clock).toISOString()
}

function addCutUser(chapter: number, over: Partial<MarkEvent> = {}): MarkEvent {
  return {
    id: `mk-${ulid()}`,
    op: 'add-cut',
    at: atTime(),
    session: 'sess_test',
    anchor: { firstMsgSeq: chapter * 100, chapter },
    by: 'user',
    evidence: 'test',
    ...over
  }
}

function addCutLlm(chapter: number, pgId: string, over: Partial<MarkEvent> = {}): MarkEvent {
  return {
    id: `mk-${ulid()}`,
    op: 'add-cut',
    at: atTime(),
    session: 'sess_test',
    anchor: { firstMsgSeq: chapter * 100, chapter },
    by: 'llm',
    proposalGroupId: pgId,
    evidence: 'test',
    ...over
  }
}

function promoteEv(pgId: string, over: Partial<MarkEvent> = {}): MarkEvent {
  return {
    id: `mk-${ulid()}`,
    op: 'promote',
    at: atTime(),
    session: 'sess_test',
    by: 'system',
    target: { proposalGroupId: pgId },
    inputDigest: 'digest',
    ...over
  }
}

function reviewEv(
  target: { proposalGroupId?: string; markId?: string },
  decision: 'approve' | 'reject',
  over: Partial<MarkEvent> = {}
): MarkEvent {
  return {
    id: `mk-${ulid()}`,
    op: 'review',
    at: atTime(),
    session: 'sess_test',
    reviewTarget: target,
    decision,
    by: 'user',
    ...over
  }
}

function suppressMark(markId: string): MarkEvent {
  return {
    id: `mk-${ulid()}`,
    op: 'suppress-cut',
    at: atTime(),
    session: 'sess_test',
    target: { markId },
    by: 'user',
    evidence: 'test'
  }
}

function suppressSignal(signalType: string, signalSeq: number): MarkEvent {
  return {
    id: `mk-${ulid()}`,
    op: 'suppress-cut',
    at: atTime(),
    session: 'sess_test',
    target: { signalType, signalSeq },
    by: 'user',
    evidence: 'test'
  }
}

const SID = 'sess_test'

// ─── Position mapping ───────────────────────────────────────────────────

describe('positionOfSeq', () => {
  const ch = makeChapters(5)
  test('inside chapter k -> boundary before k', () => {
    expect(positionOfSeq(250, ch)).toBe(2) // ch2 spans [200,250] -> boundary before ch2
  })
  test('before all -> first chapter', () => {
    expect(positionOfSeq(5, ch)).toBe(1)
  })
  test('beyond all -> null', () => {
    expect(positionOfSeq(99999, ch)).toBeNull()
  })
})

// ─── Fold: basics, total order, tie-breaks ──────────────────────────────

describe('fold', () => {
  test('no signals no marks -> single session-full group', () => {
    const r = fold(SID, [], [], makeChapters(15))
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.winner.signalType).toBe('session-full')
    expect(r.groups[0]!.boundaryKey).toBe(`${SID}:session-full:100`)
  })

  test('user-cut splits; boundaryKey uses anchor firstMsgSeq', () => {
    const r = fold(SID, [addCutUser(6)], [], makeChapters(15))
    expect(r.groups).toHaveLength(2)
    expect(r.groups[1]!.winner.signalType).toBe('user-cut')
    expect(r.groups[1]!.boundaryKey).toBe(`${SID}:user-cut:600`)
  })

  test('total order: user-cut outranks goal-set at same position', () => {
    const sig: Signal = { signalType: 'goal-set', seq: 550 } // ch5 spans [500,550] -> position 5
    const r = fold(SID, [addCutUser(5)], [sig], makeChapters(15))
    expect(r.groups).toHaveLength(2)
    expect(r.groups[1]!.winner.signalType).toBe('user-cut')
    expect(r.groups[1]!.boundaryKey).toBe(`${SID}:user-cut:500`)
  })

  test('higher-tier later arrival replaces winner -> boundaryKey change (matrix path)', () => {
    const sig: Signal = { signalType: 'goal-set', seq: 550 } // position 5
    const before = fold(SID, [], [sig], makeChapters(15))
    expect(before.groups).toHaveLength(2)
    expect(before.groups[1]!.boundaryKey).toBe(`${SID}:goal-set:550`)
    const after = fold(SID, [addCutUser(5)], [sig], makeChapters(15))
    expect(after.groups).toHaveLength(2)
    expect(after.groups[1]!.boundaryKey).toBe(`${SID}:user-cut:500`)
  })

  test('same tier: later user event wins', () => {
    const early = addCutUser(6, { at: '2026-10-20T01:00:00Z', id: `mk-a${'a'.repeat(23)}` })
    const late = addCutUser(6, { at: '2026-10-21T01:00:00Z', id: `mk-b${'b'.repeat(23)}` })
    const r = fold(SID, [early, late], [], makeChapters(15))
    expect(r.groups[1]!.winner.kind).toBe('mark')
    expect((r.groups[1]!.winner as { markId: string }).markId).toBe(late.id)
  })

  test('position-0 add-cut with effect noop never competes', () => {
    const noop = addCutUser(1, { effect: 'noop' })
    const r = fold(SID, [noop], [], makeChapters(15))
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.winner.signalType).toBe('session-full')
    expect(r.statusById.get(noop.id)).toBe('noop')
  })

  test('same-anchor conflict: later record supersedes earlier', () => {
    const a = addCutUser(6)
    const b = addCutUser(6, { supersedes: [a.id] })
    const r = fold(SID, [a, b], [], makeChapters(15))
    expect(r.statusById.get(a.id)).toBe('superseded')
    expect(r.groups).toHaveLength(2)
  })
})

// ─── Suppress three states ──────────────────────────────────────────────

describe('suppress-cut', () => {
  test('journal signal target: position-wide removal', () => {
    const sigs: Signal[] = [
      { signalType: 'goal-set', seq: 549 }, // ch5 spans [500,550]
      { signalType: 'orca-stop', seq: 550 } // same chapter -> same position
    ]
    const r0 = fold(SID, [], sigs, makeChapters(15))
    expect(r0.groups).toHaveLength(2)
    const r1 = fold(SID, [suppressSignal('goal-set', 549)], sigs, makeChapters(15))
    expect(r1.groups).toHaveLength(1) // position-wide: the orca-stop at the same position went too
  })

  test('pending llm mark target: whole group rejected', () => {
    const c1 = addCutLlm(4, 'pg-1')
    const c2 = addCutLlm(8, 'pg-1')
    const r = fold(SID, [c1, c2, suppressMark(c1.id)], [], makeChapters(15))
    expect(r.statusById.get(c1.id)).toBe('rejected')
    expect(r.statusById.get(c2.id)).toBe('rejected')
    expect(r.groups).toHaveLength(1)
    expect(r.groupStates.get('pg-1')).toBe('rejected')
  })

  test('effective llm mark target: only that boundary removed', () => {
    const c1 = addCutLlm(4, 'pg-1')
    const c2 = addCutLlm(8, 'pg-1')
    const r = fold(SID, [c1, c2, promoteEv('pg-1'), suppressMark(c1.id)], [], makeChapters(15))
    expect(r.statusById.get(c1.id)).toBe('rejected')
    expect(r.statusById.get(c2.id)).toBe('effective')
    expect(r.groups).toHaveLength(2)
    expect(r.groups[1]!.startChapter).toBe(8)
  })
})

// ─── Promotion freeze + replay stability ────────────────────────────────

describe('promotion', () => {
  test('past deadline + valid + no human trace -> promote event; frozen thereafter', () => {
    const cuts = [addCutLlm(4, 'pg-1'), addCutLlm(8, 'pg-1')]
    const created = Date.parse(cuts[0]!.at)
    const late = new Date(created + PROMOTION_DELAY_MS + 3600_000)
    const p1 = evaluatePromotions(SID, [...cuts], [], makeChapters(15), late)
    expect(p1.events).toHaveLength(1)
    expect(p1.events[0]!.op).toBe('promote')

    // after the promote event exists, re-evaluation at ANY later time produces no new decisions
    const withPromote = [...cuts, ...p1.events]
    const p2 = evaluatePromotions(
      SID,
      withPromote,
      [],
      makeChapters(15),
      new Date(created + PROMOTION_DELAY_MS * 5)
    )
    expect(p2.events).toHaveLength(0)
    // and fold is stable: identical grouping at both instants
    const f1 = fold(SID, withPromote, [], makeChapters(15))
    const f2 = fold(SID, withPromote, [], makeChapters(15))
    expect(f1.groups.map((g) => g.boundaryKey)).toEqual(f2.groups.map((g) => g.boundaryKey))
    expect(f1.groups).toHaveLength(3)
  })

  test('before deadline -> no decision', () => {
    const cuts = [addCutLlm(4, 'pg-1')]
    const early = new Date(Date.parse(cuts[0]!.at) + 1000)
    const p = evaluatePromotions(SID, cuts, [], makeChapters(15), early)
    expect(p.events).toHaveLength(0)
  })

  test('human trace inside span -> stays pending, no event', () => {
    const cuts = [addCutLlm(4, 'pg-1'), addCutLlm(8, 'pg-1')]
    const user = addCutUser(6) // interior human cut
    const late = new Date(Date.parse(cuts[0]!.at) + PROMOTION_DELAY_MS + 3600_000)
    const p = evaluatePromotions(SID, [...cuts, user], [], makeChapters(15), late)
    expect(p.events).toHaveLength(0)
    expect(p.decisions[0]).toContain('human trace')
  })

  test('revalidation failure -> reject-stale frozen', () => {
    const cuts = [addCutLlm(4, 'pg-1')]
    // a later boundary lands exactly at ch4: collision on revalidation
    const user = addCutUser(4, {
      at: new Date(Date.parse(cuts[0]!.at) + 5000).toISOString(),
      supersedes: []
    })
    const late = new Date(Date.parse(cuts[0]!.at) + PROMOTION_DELAY_MS + 3600_000)
    const p = evaluatePromotions(SID, [...cuts, user], [], makeChapters(15), late)
    expect(p.events).toHaveLength(1)
    expect(p.events[0]!.op).toBe('reject-stale')
    // frozen: later evaluation produces nothing new
    const p2 = evaluatePromotions(
      SID,
      [...cuts, user, ...p.events],
      [],
      makeChapters(15),
      new Date(late.getTime() + 10 * 86400_000)
    )
    expect(p2.events).toHaveLength(0)
  })

  test('anchor lost (chapter left live set) -> needs-review pauses evaluation', () => {
    const full = makeChapters(15)
    const cut = addCutLlm(5, 'pg-1') // anchored on chapter 5 (firstMsgSeq 500)
    const liveWithoutFive = full.filter((c) => c.index !== 5)
    const r = fold(SID, [cut], [], liveWithoutFive)
    expect(r.statusById.get(cut.id)).toBe('needs-review')
    expect(r.groupStates.get('pg-1')).toBe('needs-review')
    const late = new Date(Date.parse(cut.at) + PROMOTION_DELAY_MS * 3)
    const p = evaluatePromotions(SID, [cut], [], liveWithoutFive, late)
    expect(p.events).toHaveLength(0)
    expect(p.decisions[0]).toContain('paused')
  })
})

// ─── Proposal guard + tail exception ────────────────────────────────────

describe('proposalSpan guard', () => {
  test('no interior open anchors -> whole group', () => {
    const chapters = makeChapters(15)
    const group = fold(SID, [], [], chapters).groups[0]!
    const { span, blocked } = proposalSpan(group, [])
    expect(blocked).toBe(false)
    expect(span).toHaveLength(15)
  })

  test('effective llm anchor AT group start is not interior (guard passes)', () => {
    const c = addCutLlm(3, 'pg-0')
    const r = fold(SID, [c, promoteEv('pg-0')], [], makeChapters(15))
    const bigGroup = r.groups.find((g) => g.chapters.length > PROPOSAL_TRIGGER_CHAPTERS)!
    const { span, blocked } = proposalSpan(bigGroup, r.openLlmCuts)
    expect(blocked).toBe(false)
    expect(span).toBe(bigGroup.chapters)
  })

  test('interior pending anchors block; tail > 8 opens tail-only span', () => {
    const chapters = makeChapters(15)
    const group = fold(SID, [], [], chapters).groups[0]!
    const pendingAt4 = addCutLlm(4, 'pg-1')
    const { span, blocked } = proposalSpan(group, [pendingAt4])
    expect(blocked).toBe(false)
    expect(span[0]!.index).toBe(4)
    expect(span).toHaveLength(12)
  })

  test('tail <= 8 -> blocked', () => {
    const chapters = makeChapters(15)
    const group = fold(SID, [], [], chapters).groups[0]!
    const pendingAt8 = addCutLlm(8, 'pg-1')
    const { blocked } = proposalSpan(group, [pendingAt8])
    expect(blocked).toBe(true) // tail 8..15 = 8 chapters, not > 8
  })
})

// ─── Attempt backoff ────────────────────────────────────────────────────

describe('attempt backoff', () => {
  test('digest excludes attempt events (self-reference immunity)', () => {
    const base = [addCutUser(6)]
    const d1 = attemptDigest('gk', 'hash', base)
    const withAttempt = [...base, attemptEvent(SID, 'gk', d1, 'validation-failed')]
    const d2 = attemptDigest('gk', 'hash', withAttempt)
    expect(d1).toBe(d2)
  })

  test('validation-failed + same digest -> blocked; llm-failed -> retry allowed', () => {
    const digest = 'd123'
    const blocked = [attemptEvent(SID, 'gk', digest, 'validation-failed')]
    expect(shouldAttempt(blocked, 'gk', digest)).toBe(false)
    const transient = [attemptEvent(SID, 'gk', digest, 'llm-failed')]
    expect(shouldAttempt(transient, 'gk', digest)).toBe(true)
  })
})

// ─── Atomic validation rules ────────────────────────────────────────────

describe('validateCuts', () => {
  const span = makeChapters(10)
  const ctx = {
    activeBoundaryPositions: new Set<number>(),
    openLlmPositionsExcludingGroup: new Set<number>()
  }
  const cut = (n: number) => ({ chapter: n, firstMsgSeq: n * 100 })

  test('valid two-cut set', () => {
    expect(validateCuts([cut(4), cut(8)], span, ctx)).toBeNull()
  })
  test('rule 1: cut at span start rejected', () => {
    expect(validateCuts([cut(1)], span, ctx)).toMatch(/not strictly interior/)
  })
  test('rule 1: cut past span end rejected', () => {
    expect(validateCuts([cut(11)], span, ctx)).toMatch(/outside span/)
  })
  test('rule 2: collision with active boundary', () => {
    expect(validateCuts([cut(4)], span, { ...ctx, activeBoundaryPositions: new Set([4]) })).toMatch(
      /collides with an active boundary/
    )
  })
  test('rule 3: count cap', () => {
    expect(validateCuts([cut(2), cut(3), cut(4), cut(5), cut(6), cut(7)], span, ctx)).toMatch(
      /cut count/
    )
  })
  test('rule 4: singleton run invalid (hard)', () => {
    expect(validateCuts([cut(10)], span, ctx)).toMatch(/< 2/) // [1-9] + [10] singleton tail
  })
  test('rule 5: anchor identity mismatch', () => {
    expect(validateCuts([{ chapter: 4, firstMsgSeq: 999 }], span, ctx)).toMatch(/firstMsgSeq/)
  })
  test('rule 6: duplicate positions', () => {
    expect(validateCuts([cut(4), cut(4)], span, ctx)).toMatch(/duplicate/)
  })
})

// ─── Mixed-source single-chapter merge ──────────────────────────────────

describe('single-chapter merge (any source)', () => {
  test('user cut adjacent to effective llm cut -> 1-chapter group folds into previous', () => {
    const c1 = addCutLlm(7, 'pg-1')
    const events = [c1, promoteEv('pg-1'), addCutUser(6)]
    const r = fold(SID, events, [], makeChapters(15))
    // boundaries at 6 and 7 -> [1-5][6][7-15]; the [6] singleton folds into [1-6]
    expect(r.groups).toHaveLength(2)
    expect(r.groups[0]!.chapters.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6])
    expect(r.groups[1]!.chapters.map((c) => c.index)).toEqual(range(7, 15))
  })

  test('first group singleton stays', () => {
    const r = fold(SID, [addCutUser(2)], [], makeChapters(15))
    expect(r.groups[0]!.chapters.map((c) => c.index)).toEqual([1])
  })
})

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i)
}

// ─── chapterSetHash v2 ──────────────────────────────────────────────────

describe('chapterSetHash v2', () => {
  test('same indices, changed content -> hash changes (naming re-estimate trigger)', () => {
    const a = makeChapters(3)
    const b = makeChapters(3).map((c) => ({ ...c, versionHash: 'changed' }))
    expect(chapterSetHash(a)).not.toBe(chapterSetHash(b))
  })
  test('order-insensitive, index-sensitive', () => {
    const a = makeChapters(3)
    expect(chapterSetHash(a)).toBe(chapterSetHash(a.toReversed()))
    const renumbered = a.map((c) => ({ ...c, index: c.index + 10 }))
    expect(chapterSetHash(a)).not.toBe(chapterSetHash(renumbered))
  })
})

// ─── Review paths ───────────────────────────────────────────────────────

describe('review', () => {
  test('group approve -> members effective', () => {
    const cuts = [addCutLlm(4, 'pg-1'), addCutLlm(8, 'pg-1')]
    const r = fold(
      SID,
      [...cuts, reviewEv({ proposalGroupId: 'pg-1' }, 'approve')],
      [],
      makeChapters(15)
    )
    expect(r.statusById.get(cuts[0]!.id)).toBe('effective')
    expect(r.groups).toHaveLength(3)
  })

  test('group reject after promote -> whole group exits effective (explicit revoke path)', () => {
    const cuts = [addCutLlm(4, 'pg-1')]
    const r = fold(
      SID,
      [...cuts, promoteEv('pg-1'), reviewEv({ proposalGroupId: 'pg-1' }, 'reject')],
      [],
      makeChapters(15)
    )
    expect(r.statusById.get(cuts[0]!.id)).toBe('rejected')
    expect(r.groups).toHaveLength(1)
  })

  test('later group review overrides earlier member review', () => {
    const c1 = addCutLlm(4, 'pg-1')
    const c2 = addCutLlm(8, 'pg-1')
    const events = [
      c1,
      c2,
      reviewEv({ markId: c1.id }, 'approve'),
      reviewEv({ proposalGroupId: 'pg-1' }, 'reject') // later, group scope
    ]
    const r = fold(SID, events, [], makeChapters(15))
    expect(r.statusById.get(c1.id)).toBe('rejected')
    expect(r.statusById.get(c2.id)).toBe('rejected')
  })
})

// ─── Marks store: corruption, backup/restore, lock fencing ─────────────

describe('marks store', () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'marks-test-'))
  }

  test('missing file = empty stream (first-install path)', () => {
    const dir = tempDir()
    const r = loadMarks(dir)
    expect(r.ok).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('corrupt JSON -> recoverable failure naming the problem', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'boundaries.json'), '{ broken', 'utf8')
    const r = loadMarks(dir)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.recoverable).toBe(true)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('invalid record -> error names record index', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'boundaries.json'),
      JSON.stringify({ version: 2, events: [{ id: 'bad', op: 'nope', at: 'x', session: 's' }] }),
      'utf8'
    )
    const r = loadMarks(dir)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('record 0')
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('append writes atomically and refreshes .bak; restore recovers', () => {
    const dir = tempDir()
    const lock = AggregateLock.acquire(dir)
    const store = new MarksStore(dir, lock, [])
    store.append([addCutUser(6)])
    expect(existsSync(join(dir, 'boundaries.json.bak'))).toBe(true)
    // corrupt the main file, then restore from bak
    writeFileSync(join(dir, 'boundaries.json'), 'garbage', 'utf8')
    const bad = loadMarks(dir)
    expect(bad.ok).toBe(false)
    const restored = restoreFromBak(dir)
    expect(restored.restored).toBe(true)
    const ok = loadMarks(dir)
    expect(ok.ok && ok.events).toHaveLength(1)
    lock.release()
    rmSync(dir, { recursive: true, force: true })
  })

  test('fencing: stale takeover bumps epoch; old holder writes are rejected', () => {
    const dir = tempDir()
    const l1 = AggregateLock.acquire(dir)
    // simulate l1 going silent: write a stale heartbeat, let a second process take over
    writeFileSync(
      join(dir, '.aggregate.lock'),
      JSON.stringify({ epoch: l1.epoch, heartbeatAt: Date.now() - 10 * 3600_000 }),
      'utf8'
    )
    const l2 = AggregateLock.acquire(dir, { staleMs: 3_600_000 })
    expect(l2.epoch).toBeGreaterThan(l1.epoch)
    // l1 tries to write: epoch moved -> fencing rejection
    const store1 = new MarksStore(dir, l1, [])
    expect(() => store1.append([addCutUser(6)])).toThrow(/fencing rejection/)
    l2.release()
    rmSync(dir, { recursive: true, force: true })
  })

  test('concurrent acquire refused while held', () => {
    const dir = tempDir()
    const l1 = AggregateLock.acquire(dir)
    expect(() => AggregateLock.acquire(dir)).toThrow(/aggregate lock held/)
    l1.release()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ─── loadChapters versionHash comes from real file content ─────────────

describe('loadChapters', () => {
  test('parses frontmatter and computes versionHash from content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chapters-'))
    writeFileSync(
      join(dir, '001-first.md'),
      `---\nv: 1\nkind: session-chapter\nspan:\n  firstMsgSeq: 0\n  lastMsgSeq: 100\ntime:\n  firstTime: '2026-10-03T13:28:15.325Z'\n  lastTime: '2026-10-03T16:40:59.416Z'\n---\n\n# Ch.1 First\n\n## 要点\n- point one\n\n## 关键决策\n- decision one\n`,
      'utf8'
    )
    const ch = loadChapters(dir)
    expect(ch).toHaveLength(1)
    expect(ch[0]!.firstMsgSeq).toBe(0)
    expect(ch[0]!.lastMsgSeq).toBe(100)
    expect(ch[0]!.versionHash).toMatch(/^[0-9a-f]{8}$/)
    expect(ch[0]!.points[0]).toBe('point one')
    rmSync(dir, { recursive: true, force: true })
  })
})

function existsSync(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}
