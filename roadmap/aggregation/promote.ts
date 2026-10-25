// Lazy promotion — spec layer-002-003 v7.3
// Step 0: at first evaluation past the 72h deadline, atomically revalidate the
// proposal group against the CURRENT world and FREEZE the outcome as a
// promote / reject-stale event (replay stability). Human-touched spans stay pending.

import { sha256Hex, ulid, type MarkEvent } from './marks-store'
import { fold } from './fold'
import type { Chapter, Signal } from './chapters'
import { validateCuts, type CutCandidate } from './propose'

export const PROMOTION_DELAY_MS = 72 * 3600 * 1000

export type PromotionOutcome = { events: MarkEvent[]; decisions: string[] }

/**
 * Evaluates all pending proposal groups whose deadline has passed.
 * Pure decision function — returns the events to append (caller persists in-lock).
 */
export function evaluatePromotions(
  sessionId: string,
  events: MarkEvent[],
  signals: Signal[],
  chapters: Chapter[],
  now: Date
): PromotionOutcome {
  const result = fold(sessionId, events, signals, chapters)
  const outEvents: MarkEvent[] = []
  const decisions: string[] = []

  // collect pending groups (llm add-cuts currently pending or needs-review, grouped by pgId)
  const pendingGroups = new Map<string, MarkEvent[]>()
  for (const ev of events) {
    if (ev.op !== 'add-cut' || ev.by !== 'llm' || !ev.proposalGroupId) {
      continue
    }
    const st = result.statusById.get(ev.id)
    if (st === 'pending' || st === 'needs-review') {
      pendingGroups.set(ev.proposalGroupId, [...(pendingGroups.get(ev.proposalGroupId) ?? []), ev])
    }
  }

  for (const [pgId, members] of pendingGroups) {
    if (result.groupStates.get(pgId) === 'needs-review') {
      decisions.push(`pg ${pgId}: paused (needs-review anchor)`)
      continue // group member anchor lost — 72h evaluation suspended
    }
    const earliest = members.map((m) => Date.parse(m.at)).reduce((a, b) => Math.min(a, b), Infinity)
    if (now.getTime() < earliest + PROMOTION_DELAY_MS) {
      continue
    } // not yet due

    const cuts: CutCandidate[] = members
      .filter((m) => m.anchor)
      .map((m) => ({ chapter: m.anchor!.chapter, firstMsgSeq: m.anchor!.firstMsgSeq }))

    // locate containing folded groups per cut; track the union span the proposal covers
    const lastOf = (g: { chapters: Chapter[] }): number => g.chapters.at(-1)!.index
    const containingByCut = cuts.map((c) =>
      result.groups.filter((g) => c.chapter > g.startChapter && c.chapter <= lastOf(g))
    )
    const allContained = containingByCut.every((list) => list.length === 1)
    const minStart = Math.min(
      ...cuts.map((c, i) => containingByCut[i]![0]?.startChapter ?? c.chapter)
    )
    const maxEnd = Math.max(
      ...cuts.map((c, i) => lastOf(containingByCut[i]![0] ?? result.groups[0]!) ?? c.chapter)
    )
    const inputDigest = sha256Hex(
      JSON.stringify({
        cuts,
        span: [minStart, maxEnd],
        userPositions: [...result.userPositions]
      })
    ).slice(0, 16)

    const reject = (reason: string): void => {
      outEvents.push({
        id: `mk-${ulid()}`,
        op: 'reject-stale',
        at: now.toISOString(),
        session: sessionId,
        by: 'system',
        target: { proposalGroupId: pgId },
        inputDigest,
        evidence: reason
      })
      decisions.push(`pg ${pgId}: reject-stale (${reason})`)
    }

    // human-trace check comes FIRST (spec: human-touched spans never auto-promote
    // and never auto-reject — they stay pending for the human path)
    const interiorUser = [...result.userPositions].filter((p) => p > minStart && p <= maxEnd)
    if (interiorUser.length > 0) {
      decisions.push(`pg ${pgId}: stays pending (human trace at Ch.${interiorUser.join(', ')})`)
      continue
    }

    if (!allContained || containingByCut.some((list) => list.length !== 1)) {
      reject('cuts no longer inside a single folded group')
      continue
    }
    const span = containingByCut[0]![0]!.chapters

    // atomic revalidation against the CURRENT world (own group members excluded)
    const activeBoundaryPositions = new Set(result.groups.map((g) => g.startChapter))
    const ownIds = new Set(members.map((m) => m.id))
    const openLlmPositionsExcludingGroup = new Set(
      result.openLlmCuts.filter((c) => !ownIds.has(c.id) && c.anchor).map((c) => c.anchor!.chapter)
    )
    const invalid = validateCuts(cuts, span, {
      activeBoundaryPositions,
      openLlmPositionsExcludingGroup
    })
    if (invalid) {
      reject(invalid)
      continue
    }

    outEvents.push({
      id: `mk-${ulid()}`,
      op: 'promote',
      at: now.toISOString(),
      session: sessionId,
      by: 'system',
      target: { proposalGroupId: pgId },
      inputDigest,
      evidence: '72h auto: revalidation passed, no human trace'
    })
    decisions.push(`pg ${pgId}: promote`)
  }

  return { events: outEvents, decisions }
}
