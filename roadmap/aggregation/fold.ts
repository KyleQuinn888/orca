// Fold engine — spec layer-002-003 v7.3
// Grouping = pure function of (live chapters, journal signals, marks event stream).
// Replay derives all statuses; total-order arbitration picks each boundary's winner.

import type { MarkEvent } from './marks-store'
import { collectUserPositions } from './user-trace'
import { chapterSetHash, positionOfSeq, SIGNAL_TIER, type Chapter, type Signal } from './chapters'

export type Source =
  | { kind: 'signal'; signalType: string; seq: number; tier: number; sortKey: number }
  | {
      kind: 'mark'
      markId: string
      signalType: 'user-cut' | 'llm-cut'
      firstMsgSeq: number
      tier: number
      sortKey: number
      at: string
    }

export type MarkStatus =
  | 'pending'
  | 'effective'
  | 'rejected'
  | 'superseded'
  | 'needs-review'
  | 'noop'

export type ProposalGroupState = 'pending' | 'effective' | 'rejected' | 'needs-review'

export type Group = {
  startChapter: number
  chapters: Chapter[]
  winner: Source | { kind: 'session-full'; signalType: 'session-full'; firstMsgSeq: number }
  boundaryKey: string
  chapterSetHash: string
}

export type FoldResult = {
  groups: Group[]
  statusById: Map<string, MarkStatus>
  groupStates: Map<string, ProposalGroupState> // by proposalGroupId
  /** open (pending|effective) llm add-cut events, for guards and promotion */
  openLlmCuts: MarkEvent[]
  /** user-originated positions (chapter indices): anchor / suppress-affected / review-target */
  userPositions: Set<number>
}

const TIER_USER_CUT = 1
const TIER_LLM_CUT = 6

function sortedEvents(events: MarkEvent[]): MarkEvent[] {
  // replay order: `at` then append (file) order
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i))
    .map((x) => x.e)
}

export function fold(
  sessionId: string,
  events: MarkEvent[],
  signals: Signal[],
  chapters: Chapter[]
): FoldResult {
  const sorted = [...chapters].sort((a, b) => a.index - b.index)
  const liveFirstMsgSeqs = new Set(sorted.map((c) => c.firstMsgSeq))
  const statusById = new Map<string, MarkStatus>()
  const groupMembers = new Map<string, MarkEvent[]>() // proposalGroupId -> add-cut events
  const groupStates = new Map<string, ProposalGroupState>()

  // position -> active sources (marks and signals both)
  const sourcesAt = new Map<number, Source[]>()
  const addSource = (pos: number, s: Source): void => {
    sourcesAt.set(pos, [...(sourcesAt.get(pos) ?? []), s])
  }
  const removeMarkSource = (markId: string): void => {
    for (const [pos, list] of sourcesAt) {
      const filtered = list.filter((s) => !(s.kind === 'mark' && s.markId === markId))
      if (filtered.length === 0) {
        sourcesAt.delete(pos)
      } else if (filtered.length !== list.length) {
        sourcesAt.set(pos, filtered)
      }
    }
  }

  // journal signals enter first (they are facts, older than any mark)
  for (const sig of signals) {
    const pos = positionOfSeq(sig.seq, sorted)
    if (pos !== null) {
      addSource(pos, {
        kind: 'signal',
        signalType: sig.signalType,
        seq: sig.seq,
        tier: SIGNAL_TIER[sig.signalType],
        sortKey: sig.seq
      })
    }
  }

  const eventsById = new Map(events.map((e) => [e.id, e]))

  const activateMark = (ev: MarkEvent): void => {
    if (!ev.anchor) {
      return
    }
    addSource(ev.anchor.chapter, {
      kind: 'mark',
      markId: ev.id,
      signalType: ev.by === 'user' ? 'user-cut' : 'llm-cut',
      firstMsgSeq: ev.anchor.firstMsgSeq,
      tier: ev.by === 'user' ? TIER_USER_CUT : TIER_LLM_CUT,
      sortKey: Date.parse(ev.at),
      at: ev.at
    })
  }

  const rejectGroup = (pgId: string): void => {
    for (const member of groupMembers.get(pgId) ?? []) {
      if (statusById.get(member.id) === 'effective' || statusById.get(member.id) === 'pending') {
        statusById.set(member.id, 'rejected')
        removeMarkSource(member.id)
      }
    }
    groupStates.set(pgId, 'rejected')
  }

  for (const ev of sortedEvents(events)) {
    switch (ev.op) {
      case 'add-cut': {
        for (const sid of ev.supersedes ?? []) {
          statusById.set(sid, 'superseded')
          removeMarkSource(sid)
        }
        if (ev.effect === 'noop') {
          statusById.set(ev.id, 'noop') // audit only, never competes (position-0 add-cut)
          break
        }
        if (ev.by === 'user') {
          statusById.set(ev.id, 'effective')
          activateMark(ev)
        } else {
          // llm add-cut starts pending; becomes a source only via promote / review approve
          statusById.set(ev.id, 'pending')
          if (ev.proposalGroupId) {
            groupMembers.set(ev.proposalGroupId, [
              ...(groupMembers.get(ev.proposalGroupId) ?? []),
              ev
            ])
          }
        }
        break
      }
      case 'review': {
        const rt = ev.reviewTarget
        if (!rt) {
          break
        }
        if (rt.proposalGroupId) {
          if (ev.decision === 'approve') {
            for (const member of groupMembers.get(rt.proposalGroupId) ?? []) {
              if (statusById.get(member.id) === 'pending') {
                statusById.set(member.id, 'effective')
                activateMark(member)
              }
            }
            groupStates.set(rt.proposalGroupId, 'effective')
          } else {
            rejectGroup(rt.proposalGroupId)
          }
        } else if (rt.markId) {
          const target = eventsById.get(rt.markId)
          if (!target) {
            break
          }
          if (ev.decision === 'approve') {
            if (statusById.get(rt.markId) === 'pending') {
              statusById.set(rt.markId, 'effective')
              activateMark(target)
            }
          } else {
            statusById.set(rt.markId, 'rejected')
            removeMarkSource(rt.markId)
          }
        }
        break
      }
      case 'promote': {
        const pgId = (ev.target as { proposalGroupId?: string } | undefined)?.proposalGroupId
        if (!pgId) {
          break
        }
        for (const member of groupMembers.get(pgId) ?? []) {
          if (statusById.get(member.id) === 'pending') {
            statusById.set(member.id, 'effective')
            activateMark(member)
          }
        }
        groupStates.set(pgId, 'effective')
        break
      }
      case 'reject-stale': {
        const pgId = (ev.target as { proposalGroupId?: string } | undefined)?.proposalGroupId
        if (pgId) {
          rejectGroup(pgId)
        }
        break
      }
      case 'suppress-cut': {
        const t = ev.target
        if (!t) {
          break
        }
        if ('markId' in t) {
          const target = eventsById.get(t.markId)
          if (!target) {
            break
          }
          const st = statusById.get(t.markId)
          // the targeted mark itself always exits (rejected is one of its three spec sources)
          statusById.set(t.markId, 'rejected')
          removeMarkSource(t.markId)
          if (st === 'pending' && target.by === 'llm' && target.proposalGroupId) {
            // suppress pointing at a pending llm mark = human rejection of the whole group
            rejectGroup(target.proposalGroupId)
          } else if (target.anchor) {
            // position-wide removal of all active sources at that boundary
            sourcesAt.delete(target.anchor.chapter)
          }
        } else if ('signalSeq' in t) {
          const pos = positionOfSeq(t.signalSeq, sorted)
          if (pos !== null) {
            sourcesAt.delete(pos)
          }
        }
        break
      }
      case 'attempt':
        break // audit/backoff only, no fold effect
    }
  }

  // needs-review pass: pending/effective marks whose anchor left the live set
  for (const [id, st] of statusById) {
    if (st !== 'pending' && st !== 'effective') {
      continue
    }
    const ev = eventsById.get(id)
    if (ev?.anchor && !liveFirstMsgSeqs.has(ev.anchor.firstMsgSeq)) {
      statusById.set(id, 'needs-review')
      removeMarkSource(id)
      if (ev.proposalGroupId && st === 'pending') {
        groupStates.set(ev.proposalGroupId, 'needs-review') // pauses 72h evaluation
      }
    }
  }

  const openLlmCuts = events.filter((e) => {
    if (e.op !== 'add-cut' || e.by !== 'llm') {
      return false
    }
    const st = statusById.get(e.id)
    return st === 'pending' || st === 'effective'
  })

  const userPositions = collectUserPositions(events, signals, sorted, eventsById)

  // winners per position (total order: tier asc, sortKey desc, id asc)
  const winnerAt = new Map<number, Source>()
  for (const [pos, list] of sourcesAt) {
    const winner = [...list].sort((a, b) => {
      if (a.tier !== b.tier) {
        return a.tier - b.tier
      }
      if (a.sortKey !== b.sortKey) {
        return b.sortKey - a.sortKey // later user event / later seq wins
      }
      const ai = a.kind === 'mark' ? a.markId : `sig-${a.signalType}-${a.seq}`
      const bi = b.kind === 'mark' ? b.markId : `sig-${b.signalType}-${b.seq}`
      return ai < bi ? -1 : ai > bi ? 1 : 0
    })[0]
    if (winner) {
      winnerAt.set(pos, winner)
    }
  }

  // grouping over live chapters
  const boundaryPositions = [...winnerAt.keys()]
    .filter((p) => sorted.some((c) => c.index === p))
    .sort((a, b) => a - b)
  const sessionStart = sorted[0]?.index ?? 0
  const cuts = [...new Set([sessionStart, ...boundaryPositions])].sort((a, b) => a - b)
  const rawGroups: { start: number; chapters: Chapter[] }[] = []
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i]!
    const end = i + 1 < cuts.length ? cuts[i + 1]! : Number.MAX_SAFE_INTEGER
    const members = sorted.filter((c) => c.index >= start && c.index < end)
    if (members.length > 0) {
      rawGroups.push({ start, chapters: members })
    }
  }

  // single-chapter merge: any-source 1-chapter group folds into previous (first group exempt)
  const merged: { start: number; chapters: Chapter[] }[] = []
  for (const g of rawGroups) {
    if (g.chapters.length === 1 && merged.length > 0) {
      merged.at(-1)!.chapters.push(...g.chapters)
    } else {
      merged.push(g)
    }
  }

  const groups: Group[] = merged.map((g) => {
    const w = winnerAt.get(g.start)
    const firstChapter = g.chapters[0]!
    const winner:
      | Source
      | { kind: 'session-full'; signalType: 'session-full'; firstMsgSeq: number } = w ?? {
      kind: 'session-full',
      signalType: 'session-full',
      firstMsgSeq: firstChapter.firstMsgSeq
    }
    const canonicalSeq = winner.kind === 'signal' ? winner.seq : winner.firstMsgSeq
    return {
      startChapter: g.start,
      chapters: g.chapters,
      winner,
      boundaryKey: `${sessionId}:${winner.signalType}:${canonicalSeq}`,
      chapterSetHash: chapterSetHash(g.chapters)
    }
  })

  return { groups, statusById, groupStates, openLlmCuts, userPositions }
}
