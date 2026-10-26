// R2 UI relation derivation — spec r2-ui.md v1.2 §2.4/§2.6.
// Deterministic: continuation chains (same workspace + gap<=48h + nearest
// predecessor), overlap bands, chain-derived arcs. Fork is data-gated.

import type { R2Milestone, R2Session, R2Snapshot } from './r2-snapshot'

export const CONT_GAP_MS = 48 * 3600 * 1000

export type ContinuationEdge = {
  from: string // session id
  to: string
  gapMs: number
  inferred: true
}

export type Chain = {
  members: string[] // session ids in time order
}

export type OverlapBand = {
  startMs: number
  endMs: number
  sessions: string[] // >=2 overlapping session ids
}

export type Arc = {
  id: string
  fromMs: number
  toMs: number
  label: string
}

export type ForkEdge = {
  from: string
  to: string
  basis: string
}

export type Relations = {
  continuations: ContinuationEdge[]
  chains: Chain[]
  bands: OverlapBand[]
  arcs: Arc[]
  forks: ForkEdge[]
  forkGate: 'lineage-unavailable' | 'open'
}

const t = (s: string) => Date.parse(s)

/** predecessor: same workspace, ends before start, gap<=48h, nearest end. */
export function deriveRelations(snap: R2Snapshot): Relations {
  const byId = new Map(snap.sessions.map((s) => [s.id, s]))
  const continuations: ContinuationEdge[] = []
  for (const cur of snap.sessions) {
    const curStart = t(cur.firstTime)
    if (Number.isNaN(curStart)) {continue}
    let best: R2Session | null = null
    let bestGap = Infinity
    for (const prev of snap.sessions) {
      if (prev.id === cur.id || prev.workspace !== cur.workspace) {continue}
      const gap = curStart - t(prev.lastTime)
      if (gap >= 0 && gap <= CONT_GAP_MS && gap < bestGap) {
        best = prev
        bestGap = gap
      }
    }
    if (best) {continuations.push({ from: best.id, to: cur.id, gapMs: bestGap, inferred: true })}
  }

  // chains: connected components over continuation edges, ordered by time
  const next = new Map<string, string[]>(continuations.map((e) => [e.from, [] as string[]]))
  continuations.forEach((e) => next.get(e.from)!.push(e.to))
  const hasIn = new Set(continuations.map((e) => e.to))
  const chains: Chain[] = []
  const seen = new Set<string>()
  for (const s of snap.sessions) {
    const id = s.id
    if (seen.has(id) || !next.has(id) || hasIn.has(id)) {continue}
    const members: string[] = []
    let cur: string | undefined = id
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      members.push(cur)
      cur = next.get(cur)?.[0]
    }
    if (members.length >= 2) {chains.push({ members })}
  }

  // overlap bands: merge pairwise intersections across all sessions
  const bands: OverlapBand[] = []
  const ss = snap.sessions.filter((s) => !Number.isNaN(t(s.firstTime)) && !Number.isNaN(t(s.lastTime)))
  for (let i = 0; i < ss.length; i++) {
    for (let j = i + 1; j < ss.length; j++) {
      const a = ss[i]
      const b = ss[j]
      const start = Math.max(t(a.firstTime), t(b.firstTime))
      const end = Math.min(t(a.lastTime), t(b.lastTime))
      if (end > start) {bands.push({ startMs: start, endMs: end, sessions: [a.id, b.id] })}
    }
  }
  const merged = mergeBands(bands)

  // arcs: one per chain — first milestone start of head session -> tail session end
  const arcs: Arc[] = []
  for (const ch of chains) {
    const headId = ch.members[0]
    if (!headId) {continue}
    const head = byId.get(headId)
    const tailId = ch.members.at(-1)
    if (!tailId) {continue}
    const tail = byId.get(tailId)
    if (!head || !tail) {continue}
    const headMs = firstMilestoneStart(snap.milestones, head.id) ?? t(head.firstTime)
    const toMs = t(tail.lastTime)
    if (Number.isNaN(headMs) || Number.isNaN(toMs) || toMs <= headMs) {continue}
    const chTotal = snap.chapters.filter((c) => ch.members.includes(c.session) && !c.superseded).length
    arcs.push({ id: ch.members.join('>'), fromMs: headMs, toMs, label: `${ch.members.length} 会话 · ${chTotal} 章` })
  }

  return { continuations, chains, bands: merged, arcs, forks: [], forkGate: 'lineage-unavailable' }
}

function mergeBands(bands: OverlapBand[]): OverlapBand[] {
  const sorted = [...bands].sort((a, b) => a.startMs - b.startMs)
  const out: OverlapBand[] = []
  for (const b of sorted) {
    const last = out.at(-1)
    if (last && b.startMs <= last.endMs && b.sessions.some((s) => last.sessions.includes(s))) {
      last.endMs = Math.max(last.endMs, b.endMs)
      for (const s of b.sessions) {
        if (!last.sessions.includes(s)) {
          last.sessions.push(s)
        }
      }
    } else {
      out.push({ ...b, sessions: [...b.sessions] })
    }
  }
  return out
}

function firstMilestoneStart(ms: R2Milestone[], session: string): number | null {
  const starts = ms.filter((m) => m.session === session).map((m) => t(m.firstTime)).filter((n) => !Number.isNaN(n))
  return starts.length ? Math.min(...starts) : null
}

/**
 * Fork gate (spec §2.4): rendering engine ships in R2a; live data arrives with
 * the R1 lineage detector. Until then no fork edges are derived.
 */
export function attachForks(rel: Relations, lineage: { from: string; to: string; basis: string }[] | null): Relations {
  if (!lineage) {return rel}
  return { ...rel, forks: lineage, forkGate: 'open' }
}
