// Manual verbs (validate-then-append, in lock) — spec layer-002-003 v7.3
// add-cut / suppress-cut / review. Invalid operations are refused before write.

import { ulid, type MarkEvent, type MarksStore, type SuppressTarget } from './marks-store'
import { positionOfSeq, type Chapter } from './chapters'

export function verbAddCut(
  store: MarksStore,
  events: MarkEvent[],
  sessionId: string,
  chapters: Chapter[],
  chapterIndex: number,
  evidence: string
): string {
  const ch = chapters.find((c) => c.index === chapterIndex)
  if (!ch) {
    return `REFUSED: chapter ${chapterIndex} not in live set`
  }
  const first = [...chapters].sort((a, b) => a.index - b.index)[0]!
  const isNoop = ch.index === first.index
  // same-anchor conflict: the later record auto-supersedes the prior unsuperseded add-cut there
  const supersedes: string[] = []
  for (const ev of events) {
    if (ev.op === 'add-cut' && ev.anchor?.chapter === ch.index) {
      const laterExists = events.some((e) => (e.supersedes ?? []).includes(ev.id))
      if (!laterExists) {
        supersedes.length = 0
        supersedes.push(ev.id)
      }
    }
  }
  const ev: MarkEvent = {
    id: `mk-${ulid()}`,
    op: 'add-cut',
    at: new Date().toISOString(),
    session: sessionId,
    anchor: { firstMsgSeq: ch.firstMsgSeq, chapter: ch.index },
    by: 'user',
    evidence: evidence || 'cli:add-cut',
    supersedes
  }
  if (isNoop) {
    ev.effect = 'noop'
  }
  store.append([ev])
  return isNoop
    ? `recorded add-cut @Ch.${ch.index} as effect:noop (session first chapter)`
    : `recorded add-cut @Ch.${ch.index}`
}

export function verbSuppress(
  store: MarksStore,
  events: MarkEvent[],
  sessionId: string,
  chapters: Chapter[],
  target: SuppressTarget
): string {
  if ('markId' in target) {
    const t = events.find((e) => e.id === target.markId)
    if (!t) {
      return `REFUSED: mark ${target.markId} not found`
    }
    const state = writeGateState(t, events)
    if (state !== 'pending' && state !== 'effective') {
      return `REFUSED: mark ${target.markId} is ${state}, not open`
    }
    store.append([
      {
        id: `mk-${ulid()}`,
        op: 'suppress-cut',
        at: new Date().toISOString(),
        session: sessionId,
        target,
        by: 'user',
        evidence: 'cli:suppress'
      }
    ])
    return `recorded suppress-cut -> ${target.markId} (${state})`
  }
  const pos = positionOfSeq(target.signalSeq, chapters)
  if (pos === null) {
    return `REFUSED: signal ${target.signalType}:${target.signalSeq} does not resolve to a live boundary`
  }
  store.append([
    {
      id: `mk-${ulid()}`,
      op: 'suppress-cut',
      at: new Date().toISOString(),
      session: sessionId,
      target,
      by: 'user',
      evidence: 'cli:suppress'
    }
  ])
  return `recorded suppress-cut -> signal ${target.signalType}:${target.signalSeq} (@Ch.${pos})`
}

export function verbReview(
  store: MarksStore,
  events: MarkEvent[],
  sessionId: string,
  target: string,
  decision: 'approve' | 'reject',
  reason: string
): string {
  const isPg = target.startsWith('pg-')
  const exists = events.some((e) =>
    isPg
      ? e.proposalGroupId === target ||
        ('proposalGroupId' in (e.target ?? {}) &&
          (e.target as { proposalGroupId?: string }).proposalGroupId === target)
      : e.id === target
  )
  if (!exists) {
    return `REFUSED: ${target} not found`
  }
  store.append([
    {
      id: `mk-${ulid()}`,
      op: 'review',
      at: new Date().toISOString(),
      session: sessionId,
      reviewTarget: isPg ? { proposalGroupId: target } : { markId: target },
      decision,
      by: 'user',
      reason: reason || 'cli:review'
    }
  ])
  return `recorded review ${decision} -> ${target}`
}

/** Lightweight write-time gate: superseded / rejected / effective / pending. */
function writeGateState(ev: MarkEvent, events: MarkEvent[]): string {
  if (events.some((e) => (e.supersedes ?? []).includes(ev.id))) {
    return 'superseded'
  }
  if (ev.by === 'user') {
    return 'effective'
  }
  const pgRejected =
    events.some(
      (e) =>
        e.op === 'reject-stale' &&
        (e.target as { proposalGroupId?: string }).proposalGroupId === ev.proposalGroupId
    ) ||
    events.some(
      (e) =>
        e.op === 'review' &&
        e.decision === 'reject' &&
        (e.reviewTarget?.proposalGroupId === ev.proposalGroupId || e.reviewTarget?.markId === ev.id)
    )
  if (pgRejected) {
    return 'rejected'
  }
  const approved = events.some(
    (e) =>
      (e.op === 'promote' &&
        (e.target as { proposalGroupId?: string }).proposalGroupId === ev.proposalGroupId) ||
      (e.op === 'review' &&
        e.decision === 'approve' &&
        (e.reviewTarget?.proposalGroupId === ev.proposalGroupId ||
          e.reviewTarget?.markId === ev.id))
  )
  return approved ? 'effective' : 'pending'
}
