import { describe, expect, it } from 'bun:test'
import {
  capRemaining,
  completePending,
  DAILY_CAP,
  emptyState,
  enqueuePending,
  getOrCreateSession,
  isOptedIn,
  optIn,
  optOut,
  recordSpawn,
  utcDateKey
} from './roadmap-store'

describe('roadmap-store', () => {
  it('optIn/optOut manages the session list', () => {
    const state = emptyState()
    expect(isOptedIn(state, 's1')).toBe(false)
    optIn(state, 's1')
    expect(isOptedIn(state, 's1')).toBe(true)
    optIn(state, 's1') // idempotent
    expect(state.optedIn).toHaveLength(1)
    optOut(state, 's1')
    expect(isOptedIn(state, 's1')).toBe(false)
  })

  it('daily cap counts and reports remaining', () => {
    const state = emptyState()
    const session = getOrCreateSession(state, 's1')
    const date = utcDateKey()
    expect(capRemaining(session, date)).toBe(DAILY_CAP)
    for (let i = 0; i < DAILY_CAP; i++) {
      recordSpawn(session, date)
    }
    expect(capRemaining(session, date)).toBe(0)
    // Next day resets
    const tomorrow = utcDateKey(new Date(Date.now() + 86400000))
    expect(capRemaining(session, tomorrow)).toBe(DAILY_CAP)
  })

  it('pending queue is idempotent by chapterKey', () => {
    const state = emptyState()
    const session = getOrCreateSession(state, 's1')
    expect(enqueuePending(session, 'e1', 10, { epoch: 'e1', seq: 50 })).toBe(true)
    expect(enqueuePending(session, 'e1', 10, { epoch: 'e1', seq: 50 })).toBe(false) // dup
    expect(session.pending).toHaveLength(1)
    completePending(session, 'e1:10')
    expect(session.pending).toHaveLength(0)
  })

  it('pending queue merges on overflow', () => {
    const state = emptyState()
    const session = getOrCreateSession(state, 's1')
    for (let i = 0; i < 7; i++) {
      enqueuePending(session, 'e1', i * 10, { epoch: 'e1', seq: i * 10 + 5 })
    }
    expect(session.pending.length).toBeLessThanOrEqual(5)
    // At least one merged key
    expect(session.pending.some((p) => p.chapterKey.includes('+'))).toBe(true)
  })

  it('prunes old date keys', () => {
    const state = emptyState()
    const session = getOrCreateSession(state, 's1')
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      recordSpawn(session, d)
    }
    expect(Object.keys(session.counts).length).toBeLessThanOrEqual(7)
  })
})
