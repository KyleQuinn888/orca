// Roadmap state store: dual cursors (scan/summarized), per-session opt-in
// list, daily cap counts, pending chapter queue. Atomic writes to per-profile
// userData.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Cursor = { epoch: string; seq: number }

export type PendingChapter = {
  chapterKey: string // `${epoch}:${startSeq}` — idempotent key
  boundary: Cursor
  createdAt: string
}

export type SessionState = {
  scanCursor: Cursor
  summarizedCursor: Cursor
  counts: Record<string, number> // date (UTC YYYY-MM-DD) -> spawn count
  pending: PendingChapter[]
}

/** Spec session-enablement v1.3 §2: policy axis. candidate is derived (unset), never persisted. */
export type SessionPolicy = 'eligible' | 'excluded' | 'deleted'

/** Threshold metrics (spec §1 L2): user turns, successful file edits, distinct files touched. */
export type SessionMetrics = {
  turns: number
  edits: number
  /** distinct file paths, bounded (count keeps growing, list capped) */
  files: string[]
  fileCount: number
}

export type RoadmapStateV2 = {
  version: 2
  /** terminal/active policy per session; absent = candidate */
  policy: Record<string, SessionPolicy>
  metrics: Record<string, SessionMetrics>
  sessions: Record<string, SessionState>
}

export type RoadmapState = RoadmapStateV2 | { version: 1; optedIn: string[]; sessions: Record<string, SessionState> }

export const DAILY_CAP = 20

export function emptyState(): RoadmapStateV2 {
  return { version: 2, policy: {}, metrics: {}, sessions: {} }
}

/** v1 -> v2: optedIn entries become eligible; everything else starts candidate. */
export function migrateState(state: RoadmapState): RoadmapStateV2 {
  if (state.version === 2) {
    return state
  }
  const policy: Record<string, SessionPolicy> = {}
  for (const sid of state.optedIn) {
    policy[sid] = 'eligible'
  }
  return { version: 2, policy, metrics: {}, sessions: state.sessions }
}

export function stateFilePath(userDataDir: string): string {
  return join(userDataDir, 'roadmap-state.json')
}

export function loadState(userDataDir: string): RoadmapStateV2 {
  const path = stateFilePath(userDataDir)
  if (!existsSync(path)) {
    return emptyState()
  }
  try {
    return migrateState(JSON.parse(readFileSync(path, 'utf8')) as RoadmapState)
  } catch {
    console.warn('[roadmap] state file unparseable, starting fresh')
    return emptyState()
  }
}

export function saveState(userDataDir: string, state: RoadmapState): void {
  mkdirSync(userDataDir, { recursive: true })
  const path = stateFilePath(userDataDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
}

// ─── Session helpers ────────────────────────────────────────────────────

export function getOrCreateSession(state: RoadmapState, sessionId: string): SessionState {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      scanCursor: { epoch: '', seq: 0 },
      summarizedCursor: { epoch: '', seq: 0 },
      counts: {},
      pending: []
    }
  }
  return state.sessions[sessionId]!
}

/** Terminal states override every writer (spec §0); active means pipeline may run. */
export function isActive(state: RoadmapStateV2, sessionId: string): boolean {
  return state.policy[sessionId] === 'eligible'
}

export function isTerminal(state: RoadmapStateV2, sessionId: string): boolean {
  const p = state.policy[sessionId]
  return p === 'excluded' || p === 'deleted'
}

export function setPolicy(state: RoadmapStateV2, sessionId: string, p: SessionPolicy): void {
  state.policy[sessionId] = p
}

export function metricsOf(state: RoadmapStateV2, sessionId: string): SessionMetrics {
  if (!state.metrics[sessionId]) {
    state.metrics[sessionId] = { turns: 0, edits: 0, files: [], fileCount: 0 }
  }
  return state.metrics[sessionId]!
}

const METRICS_FILE_CAP = 50

export function recordMetrics(m: SessionMetrics, delta: { turn?: boolean; edit?: boolean; file?: string | null }): void {
  if (delta.turn) {
    m.turns += 1
  }
  if (delta.edit) {
    m.edits += 1
  }
  if (delta.file) {
    m.fileCount += 1
    if (!m.files.includes(delta.file) && m.files.length < METRICS_FILE_CAP) {
      m.files.push(delta.file)
    }
  }
}

// ─── Daily cap ──────────────────────────────────────────────────────────

export function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function capRemaining(session: SessionState, dateKey = utcDateKey()): number {
  return Math.max(0, DAILY_CAP - (session.counts[dateKey] ?? 0))
}

export function recordSpawn(session: SessionState, dateKey = utcDateKey()): void {
  session.counts[dateKey] = (session.counts[dateKey] ?? 0) + 1
  // Prune old dates (keep last 7)
  const keys = Object.keys(session.counts).sort()
  if (keys.length > 7) {
    for (const k of keys.slice(0, -7)) {
      delete session.counts[k]
    }
  }
}

// ─── Pending queue ──────────────────────────────────────────────────────

export function enqueuePending(
  session: SessionState,
  epoch: string,
  startSeq: number,
  boundary: Cursor
): boolean {
  const chapterKey = `${epoch}:${startSeq}`
  // Idempotent: don't re-enqueue same chapter
  if (session.pending.some((p) => p.chapterKey === chapterKey)) {
    return false
  }
  session.pending.push({
    chapterKey,
    boundary,
    createdAt: new Date().toISOString()
  })
  // Cap at 5; merge oldest two if overflow
  if (session.pending.length > 5) {
    const first = session.pending.shift()!
    const second = session.pending.shift()!
    session.pending.unshift({
      ...second,
      chapterKey: `${first.chapterKey}+${second.chapterKey}`
    })
    console.warn(
      `[roadmap] pending overflow, merged chapters ${first.chapterKey} + ${second.chapterKey}`
    )
  }
  return true
}

export function completePending(session: SessionState, chapterKey: string): void {
  session.pending = session.pending.filter((p) => p.chapterKey !== chapterKey)
}
