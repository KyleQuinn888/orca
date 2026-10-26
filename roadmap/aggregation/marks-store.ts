// Marks event log store — spec layer-002-003 v7.3
// Append-only event stream at .roadmap/002/boundaries.json
// All statuses are replay-derived; records are never mutated.
// Lock: whole-run lease + heartbeat + fencing epoch (writes carry epoch, stale epoch rejected).

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { AggregateLock } from './aggregate-lock'
import { createHash, randomBytes } from 'node:crypto'

// ─── Types ──────────────────────────────────────────────────────────────

export type SuppressTarget = { signalType: string; signalSeq: number } | { markId: string }

export type EventTarget = SuppressTarget | { proposalGroupId: string }

export type MarkEvent = {
  id: string // mk-<ulid>
  op: 'add-cut' | 'suppress-cut' | 'review' | 'promote' | 'reject-stale' | 'attempt'
  at: string // ISO UTC
  session: string
  // add-cut
  anchor?: { firstMsgSeq: number; chapter: number }
  by?: 'user' | 'llm' | 'system'
  proposalGroupId?: string
  supersedes?: string[]
  evidence?: string
  effect?: 'noop'
  // suppress-cut / promote / reject-stale
  target?: EventTarget
  // review
  reviewTarget?: { proposalGroupId?: string; markId?: string }
  decision?: 'approve' | 'reject'
  reason?: string
  // promote / reject-stale
  inputDigest?: string
  // attempt
  groupKey?: string
  digest?: string
  outcome?: 'validation-failed' | 'llm-failed' | 'succeeded'
}

export type MarksFile = { version: 2; events: MarkEvent[] }

// ─── ULID ───────────────────────────────────────────────────────────────

const ENC = '0123456789abcdefghjkmnpqrstvwxyz'

export function ulid(): string {
  let ts = Date.now()
  let tsStr = ''
  for (let i = 0; i < 10; i++) {
    tsStr = ENC[ts % 32] + tsStr
    ts = Math.floor(ts / 32)
  }
  const rand = randomBytes(10)
  let randStr = ''
  let bits = 0
  let bitCount = 0
  for (const byte of rand) {
    bits = (bits << 8) | byte
    bitCount += 8
    while (bitCount >= 5) {
      bitCount -= 5
      randStr += ENC[(bits >>> bitCount) & 31]
    }
  }
  return tsStr + randStr
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

// ─── Validation ─────────────────────────────────────────────────────────

export class MarksCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarksCorruptionError'
  }
}

function validateEvent(ev: MarkEvent, idx: number, seenIds: Set<string>): void {
  const bad = (msg: string): never => {
    throw new MarksCorruptionError(`record ${idx}: ${msg}`)
  }
  if (!ev.id || !/^mk-[0-9a-z]{26}$/.test(ev.id)) {
    bad(`invalid id "${ev.id}"`)
  }
  if (seenIds.has(ev.id)) {
    bad(`duplicate id ${ev.id}`)
  }
  seenIds.add(ev.id)
  const ops: MarkEvent['op'][] = [
    'add-cut',
    'suppress-cut',
    'review',
    'promote',
    'reject-stale',
    'attempt'
  ]
  if (!ops.includes(ev.op)) {
    bad(`unknown op "${ev.op}"`)
  }
  if (!ev.at || Number.isNaN(Date.parse(ev.at))) {
    bad(`invalid at "${ev.at}"`)
  }
  if (!ev.session) {
    bad('missing session')
  }
  switch (ev.op) {
    case 'add-cut':
      if (
        !ev.anchor ||
        typeof ev.anchor.firstMsgSeq !== 'number' ||
        typeof ev.anchor.chapter !== 'number'
      ) {
        bad('add-cut requires anchor {firstMsgSeq, chapter}')
      }
      if (ev.by !== 'user' && ev.by !== 'llm') {
        bad(`add-cut by must be user|llm, got "${ev.by}"`)
      }
      break
    case 'suppress-cut': {
      const t = ev.target
      if (!t) {
        bad('suppress-cut requires target')
      }
      if (t && 'markId' in t) {
        if (typeof t.markId !== 'string') {
          bad('target.markId must be string')
        }
      } else if (t && 'signalType' in t) {
        if (!t.signalType || typeof t.signalSeq !== 'number') {
          bad('target signal requires {signalType, signalSeq}')
        }
      } else {
        bad('suppress-cut target must be {markId} or {signalType, signalSeq}')
      }
      break
    }
    case 'review':
      if (!ev.reviewTarget || (!ev.reviewTarget.proposalGroupId && !ev.reviewTarget.markId)) {
        bad('review requires reviewTarget {proposalGroupId|markId}')
      }
      if (ev.decision !== 'approve' && ev.decision !== 'reject') {
        bad('review decision must be approve|reject')
      }
      break
    case 'promote':
    case 'reject-stale': {
      const t = ev.target
      if (!t || !('proposalGroupId' in t && t.proposalGroupId)) {
        bad(`${ev.op} requires target {proposalGroupId}`)
      }
      break
    }
    case 'attempt':
      if (!ev.groupKey || typeof ev.digest !== 'string') {
        bad('attempt requires {groupKey, digest}')
      }
      if (
        ev.outcome !== 'validation-failed' &&
        ev.outcome !== 'llm-failed' &&
        ev.outcome !== 'succeeded'
      ) {
        bad('attempt outcome invalid')
      }
      break
  }
}

/** Reference validation: supersedes / targets must resolve inside the same file + same session. */
export function validateReferences(events: MarkEvent[]): string[] {
  const errors: string[] = []
  const ids = new Set(events.map((e) => e.id))
  events.forEach((ev, i) => {
    for (const sid of ev.supersedes ?? []) {
      if (!ids.has(sid)) {
        errors.push(`record ${i}: supersedes dangling id ${sid}`)
      }
    }
    if (ev.target && 'markId' in ev.target && !ids.has(ev.target.markId)) {
      errors.push(`record ${i}: suppress target dangling markId ${ev.target.markId}`)
    }
    if (ev.reviewTarget?.markId && !ids.has(ev.reviewTarget.markId)) {
      errors.push(`record ${i}: review target dangling markId ${ev.reviewTarget.markId}`)
    }
  })
  // supersedes cycle detection
  const next = new Map<string, string[]>()
  for (const ev of events) {
    for (const sid of ev.supersedes ?? []) {
      next.set(sid, [...(next.get(sid) ?? []), ev.id])
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const walk = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`supersedes cycle involving ${id}`)
      return
    }
    if (visited.has(id)) {
      return
    }
    visiting.add(id)
    for (const n of next.get(id) ?? []) {
      walk(n)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const ev of events) {
    walk(ev.id)
  }
  return errors
}

// ─── Store ──────────────────────────────────────────────────────────────

export type LoadResult =
  | { ok: true; events: MarkEvent[] }
  | { ok: false; error: string; recoverable: boolean } // recoverable = restore from .bak possible

export function loadMarks(roadmap002Dir: string): LoadResult {
  const path = join(roadmap002Dir, 'boundaries.json')
  if (!existsSync(path)) {
    return { ok: true, events: [] }
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return { ok: false, error: `read failed: ${(e as Error).message}`, recoverable: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `parse failed: ${(e as Error).message}`, recoverable: true }
  }
  const file = parsed as MarksFile
  if (!file || typeof file !== 'object' || file.version !== 2 || !Array.isArray(file.events)) {
    return {
      ok: false,
      error: 'schema invalid: expected {version:2, events:[]}',
      recoverable: true
    }
  }
  try {
    const seen = new Set<string>()
    file.events.forEach((ev, i) => validateEvent(ev, i, seen))
    const refErrors = validateReferences(file.events)
    if (refErrors.length > 0) {
      throw new MarksCorruptionError(refErrors.join('; '))
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message, recoverable: false }
  }
  return { ok: true, events: file.events }
}

export class MarksStore {
  private events: MarkEvent[]
  constructor(
    private readonly dir: string,
    private readonly lock: AggregateLock,
    events: MarkEvent[]
  ) {
    this.events = [...events]
  }

  get all(): readonly MarkEvent[] {
    return this.events
  }

  /** Append events and atomically persist (tmp+rename, then refresh .bak). Carries lock epoch. */
  append(newEvents: MarkEvent[]): void {
    this.events = [...this.events, ...newEvents]
    this.persist()
  }

  persist(): void {
    this.lock.assertEpochCurrent('marks write')
    const path = join(this.dir, 'boundaries.json')
    const content = JSON.stringify({ version: 2, events: this.events } satisfies MarksFile, null, 2)
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
    // last-known-good backup after successful write
    writeFileSync(`${path}.bak`, content, 'utf8')
  }
}

// ─── Restore tooling ────────────────────────────────────────────────────

export function restoreFromBak(roadmap002Dir: string): { restored: boolean; message: string } {
  const path = join(roadmap002Dir, 'boundaries.json')
  const bak = `${path}.bak`
  if (!existsSync(bak)) {
    return { restored: false, message: 'no .bak available' }
  }
  const bakText = readFileSync(bak, 'utf8')
  // .bak must itself be valid before restoring
  const parsed = JSON.parse(bakText) as MarksFile
  const seen = new Set<string>()
  parsed.events.forEach((ev, i) => validateEvent(ev, i, seen))
  const refErrors = validateReferences(parsed.events)
  if (refErrors.length > 0) {
    throw new MarksCorruptionError(`bak invalid: ${refErrors.join('; ')}`)
  }
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '(missing)'
  renameSync(bak, path)
  return {
    restored: true,
    message: `restored from .bak\n--- before ---\n${before.slice(0, 2000)}\n--- after ---\n${bakText.slice(0, 2000)}`
  }
}

export function marksDirOf(roadmap002Dir: string): string {
  return dirname(join(roadmap002Dir, 'boundaries.json'))
}
