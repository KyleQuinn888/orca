// Human-trace position collection — spec layer-002-003 v7.3
// Used by promotion's human-trace detection: user add-cut anchors,
// suppress-affected and review-target positions, and user-mark signals.

import type { MarkEvent } from './marks-store'
import { positionOfSeq, type Chapter, type Signal } from './chapters'

/** Human-trace positions: user add-cut anchors, suppress-affected and review-target positions, user-mark signals. */
export function collectUserPositions(
  events: MarkEvent[],
  signals: Signal[],
  sorted: Chapter[],
  eventsById: Map<string, MarkEvent>
): Set<number> {
  const userPositions = new Set<number>()
  for (const ev of events) {
    if (ev.by !== 'user' && ev.op !== 'review') {
      continue
    }
    if (ev.op === 'add-cut' && ev.anchor && ev.effect !== 'noop') {
      userPositions.add(ev.anchor.chapter)
    }
    if (ev.op === 'suppress-cut' && ev.target) {
      if ('markId' in ev.target) {
        const t = eventsById.get(ev.target.markId)
        if (t?.anchor) {
          userPositions.add(t.anchor.chapter)
        }
      } else if ('signalSeq' in ev.target) {
        const pos = positionOfSeq(ev.target.signalSeq, sorted)
        if (pos !== null) {
          userPositions.add(pos)
        }
      }
    }
    if (ev.op === 'review' && ev.reviewTarget?.markId) {
      const t = eventsById.get(ev.reviewTarget.markId)
      if (t?.anchor) {
        userPositions.add(t.anchor.chapter)
      }
    }
  }
  for (const sig of signals) {
    if (sig.signalType === 'user-mark') {
      const pos = positionOfSeq(sig.seq, sorted)
      if (pos !== null) {
        userPositions.add(pos)
      }
    }
  }
  return userPositions
}
