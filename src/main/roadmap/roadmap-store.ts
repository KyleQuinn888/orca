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

export type RoadmapState = {
  version: 1
  optedIn: string[]
  sessions: Record<string, SessionState>
}

export const DAILY_CAP = 20

export function emptyState(): RoadmapState {
  return { version: 1, optedIn: [], sessions: {} }
}

export function stateFilePath(userDataDir: string): string {
  return join(userDataDir, 'roadmap-state.json')
}

export function loadState(userDataDir: string): RoadmapState {
  const path = stateFilePath(userDataDir)
  if (!existsSync(path)) {
    return emptyState()
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RoadmapState
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

export function isOptedIn(state: RoadmapState, sessionId: string): boolean {
  return state.optedIn.includes(sessionId)
}

export function optIn(state: RoadmapState, sessionId: string): void {
  if (!isOptedIn(state, sessionId)) {
    state.optedIn.push(sessionId)
  }
}

export function optOut(state: RoadmapState, sessionId: string): void {
  state.optedIn = state.optedIn.filter((id) => id !== sessionId)
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
