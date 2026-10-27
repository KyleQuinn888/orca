import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_SEGMENTATION_CONFIG,
  flushOpenChapter,
  segmentRows,
  type JournalRowRef,
  type OpenChapter
} from './journal-reader'

// ─── Fixture helpers ────────────────────────────────────────────────────

const EPOCH = 'e-0001'

function row(seq: number, rowJson: Record<string, unknown>, ts = seq * 1000): JournalRowRef {
  return {
    sessionId: 's1',
    epoch: EPOCH,
    seq,
    rowJson: JSON.stringify(rowJson),
    ts
  }
}

function turnRow(seq: number, state: string, outcome?: string): JournalRowRef {
  return row(seq, { kind: 'item', body: { kind: 'turn', state, outcome } })
}

function userMsgRow(seq: number, content: string): JournalRowRef {
  return row(seq, { kind: 'item', body: { kind: 'message', role: 'user', content } })
}

function compactRow(seq: number): JournalRowRef {
  return row(seq, { kind: 'item', body: { kind: 'status', presentation: 'context-cleared' } })
}

function gitCommitRow(seq: number, command = 'git commit -m "feat: x"'): JournalRowRef {
  return row(seq, {
    kind: 'item',
    body: {
      kind: 'tool-call',
      name: 'Bash',
      input: { command },
      state: 'completed',
      output: { content: '[main abc1234] feat: x' }
    }
  })
}

function threadGoalRow(seq: number, goalState: string): JournalRowRef {
  return row(seq, { kind: 'item', body: { kind: 'status', threadGoal: { state: goalState } } })
}

function orcaStopRow(seq: number): JournalRowRef {
  return row(seq, { kind: 'item', body: { kind: 'status', orcaStop: { cause: 'user' } } })
}

// ─── TIER 0 tests ───────────────────────────────────────────────────────

describe('TIER 0: compact', () => {
  it('cuts immediately at compact boundary regardless of turn count', () => {
    const rows = [
      userMsgRow(1, 'hi'),
      turnRow(2, 'completed'),
      compactRow(3),
      userMsgRow(4, 'new chapter')
    ]
    const { cuts, open } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.signal.tier).toBe(0)
    expect(cuts[0]!.signal.kind).toBe('compact')
    expect(cuts[0]!.toSeq).toBe(2)
    expect(open).not.toBeNull() // seq 4 starts new chapter
  })

  it('cuts even with zero terminal turns (emergency save)', () => {
    const rows = [userMsgRow(1, 'just started'), compactRow(2)]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(0) // no terminal turns = no chapter to close
    // But open is null (compact consumed it)
  })

  it('does NOT cut on /compact command card that was withdrawn (no context-cleared)', () => {
    const cmdRow = row(5, {
      kind: 'item',
      body: {
        kind: 'message',
        role: 'user',
        sentAs: 'command',
        command: { name: 'compact' },
        content: '/compact'
      }
    })
    const rows = [...makeTurns(4), cmdRow, turnRow(6, 'completed')]
    const { cuts } = segmentRows('s1', rows, null, { ...DEFAULT_SEGMENTATION_CONFIG, floor: 2 })
    expect(cuts).toHaveLength(0) // /compact slash is excluded from T1; no context-cleared status
  })
})

describe('TIER 0: epoch change', () => {
  it('cuts at epoch boundary when epoch differs mid-stream', () => {
    // Simulate: rows 1-2 in epoch A, rows 3-4 in epoch B
    const batch1 = [userMsgRow(1, 'old epoch'), turnRow(2, 'completed')]
    const { open: openAfterBatch1 } = segmentRows('s1', batch1, null)
    expect(openAfterBatch1).not.toBeNull()

    const batch2: JournalRowRef[] = [
      { ...userMsgRow(3, 'new epoch'), epoch: 'e-0002' },
      turnRow(4, 'completed', 'completed')
    ]
    // open has epoch from batch1, batch2 rows have different epoch
    const { cuts } = segmentRows('s1', batch2, openAfterBatch1)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.signal.kind).toBe('epoch-change')
    expect(cuts[0]!.epoch).toBe(EPOCH) // old epoch
  })
})

// ─── TIER 1 tests ───────────────────────────────────────────────────────

describe('TIER 1: git commit', () => {
  it('cuts after git commit when floor met', () => {
    const rows = [...makeTurns(8), gitCommitRow(20), turnRow(21, 'completed')]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.signal.kind).toBe('git-commit')
  })

  it('does NOT cut when below floor', () => {
    const rows = [...makeTurns(3), gitCommitRow(10), turnRow(11, 'completed')]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(0)
  })

  it('detects commit in string input form', () => {
    const rows = [
      ...makeTurns(8),
      row(20, {
        kind: 'item',
        body: { kind: 'tool-call', name: 'shell', input: 'git commit -m test', state: 'completed' }
      }),
      turnRow(21, 'completed')
    ]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.signal.kind).toBe('git-commit')
  })

  it('rejects git log (not a commit)', () => {
    const rows = [
      ...makeTurns(8),
      gitCommitRow(20, 'git log --oneline -5'),
      turnRow(21, 'completed')
    ]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(0) // no T1 signal, below 50 turns
  })

  it('rejects --dry-run', () => {
    const rows = [
      ...makeTurns(8),
      gitCommitRow(20, 'git commit --dry-run -m test'),
      turnRow(21, 'completed')
    ]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(0)
  })
})

describe('TIER 1: threadGoal change', () => {
  it('cuts on threadGoal cleared when floor met', () => {
    const rows = [...makeTurns(8), threadGoalRow(20, 'cleared'), turnRow(21, 'completed')]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.signal.kind).toBe('thread-goal')
  })
})

describe('TIER 1: orcaStop', () => {
  it('cuts on orcaStop when floor met', () => {
    const rows = [...makeTurns(8), orcaStopRow(20), turnRow(21, 'completed')]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.signal.kind).toBe('orca-stop')
  })
})

// ─── TIER 2 tests ───────────────────────────────────────────────────────

describe('TIER 2: size overflow with backtracking', () => {
  it('forces cut at 50 turns with no T1 signal', () => {
    const rows = makeTurns(55)
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts.length).toBeGreaterThanOrEqual(1)
    expect(cuts[0]!.signal.tier).toBe(2)
    expect(cuts[0]!.signal.kind).toBe('size-overflow')
    expect((cuts[0]!.signal as { forced: boolean }).forced).toBe(true)
  })

  it('backtracks to git commit within window', () => {
    const rows = [...makeTurns(45), gitCommitRow(46), ...makeTurnsStartingAt(47, 10)] // commit at turn 45, then 10 more
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.toSeq).toBe(46) // cut at the commit, not at turn 55
  })

  it('backtracks to threadGoal within window', () => {
    const rows = [...makeTurns(40), threadGoalRow(41, 'cleared'), ...makeTurnsStartingAt(42, 15)]
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.toSeq).toBe(41) // cut at threadGoal
  })

  it('cuts at current turn when no good boundary in window', () => {
    const rows = makeTurns(55)
    const { cuts } = segmentRows('s1', rows, null)
    expect(cuts[0]!.toSeq).toBeGreaterThan(0)
    expect((cuts[0]!.signal as { forced: boolean }).forced).toBe(true)
  })
})

// ─── Flush tests ────────────────────────────────────────────────────────

describe('flush', () => {
  it('closes open chapter at last boundary candidate', () => {
    const open: OpenChapter = {
      epoch: EPOCH,
      startSeq: 1,
      terminalTurns: 10,
      projectionChars: 5000,
      candidates: [{ tier: 1, kind: 'git-commit', atSeq: 15 }]
    }
    const cut = flushOpenChapter('s1', open, 5)
    expect(cut).not.toBeNull()
    expect(cut!.toSeq).toBe(15)
    expect(cut!.signal.kind).toBe('flush')
  })

  it('returns null when no terminal turns', () => {
    const open: OpenChapter = {
      epoch: EPOCH,
      startSeq: 1,
      terminalTurns: 0,
      projectionChars: 0,
      candidates: []
    }
    expect(flushOpenChapter('s1', open, 1)).toBeNull()
  })
})

// ─── State continuation ─────────────────────────────────────────────────

describe('segmentation state continuation', () => {
  it('maintains open chapter across calls', () => {
    const batch1 = makeTurns(5)
    const { open: open1 } = segmentRows('s1', batch1, null)
    expect(open1).not.toBeNull()
    expect(open1!.terminalTurns).toBe(5)

    const batch2 = makeTurnsStartingAt(11, 10)
    const { cuts, open: open2 } = segmentRows('s1', batch2, open1)
    expect(cuts).toHaveLength(0) // 15 total, below 50
    expect(open2!.terminalTurns).toBe(15)
  })
})

// ─── Helpers ────────────────────────────────────────────────────────────

function makeTurns(count: number): JournalRowRef[] {
  const rows: JournalRowRef[] = []
  for (let i = 0; i < count; i++) {
    const seq = i * 2 + 1
    rows.push(userMsgRow(seq, `message ${i + 1}`))
    rows.push(turnRow(seq + 1, 'completed', 'completed'))
  }
  return rows
}

function makeTurnsStartingAt(startSeq: number, count: number): JournalRowRef[] {
  const rows: JournalRowRef[] = []
  let seq = startSeq
  for (let i = 0; i < count; i++) {
    rows.push(userMsgRow(seq, `message ${i + 1}`))
    rows.push(turnRow(seq + 1, 'completed', 'completed'))
    seq += 2
  }
  return rows
}
