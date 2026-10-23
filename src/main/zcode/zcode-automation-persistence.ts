// Automation records on disk, so a restart keeps its promises: the store's
// own shape, written whole on every mutation, read back on construction.
// A missed run within the grace window still fires once after restart; one
// older than that skips forward to the next occurrence instead of piling up.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

import type { ZcodeAutomationRecord } from './zcode-automation-store'
import { readZcodeSchedule, type ZcodeAutomationSchedule } from './zcode-automation-schedule'

const GRACE_MS = 10 * 60_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type PersistedRecord = Omit<ZcodeAutomationRecord, 'schedule'> & {
  scheduleKind: 'relative' | 'interval' | 'cron'
  cronExpr?: string
  intervalUnit?: string
  interval?: number
  delayMinutes?: number
}

/** Reads persisted records; null when none were ever written. */
export function readZcodeAutomations(path: string): ZcodeAutomationRecord[] | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed
    .map((entry): ZcodeAutomationRecord | null => adopt(entry, Date.now()))
    .filter((record): record is ZcodeAutomationRecord => record !== null)
}

/** Writes the records atomically (temp file + rename), whole-file. */
export function writeZcodeAutomations(
  path: string,
  records: readonly ZcodeAutomationRecord[]
): void {
  const persisted: PersistedRecord[] = records.map((record) => ({
    ...record,
    scheduleKind: record.schedule.kind,
    ...(record.schedule.kind === 'cron'
      ? { cronExpr: record.schedule.expr }
      : record.schedule.kind === 'interval'
        ? { intervalUnit: record.schedule.unit, interval: record.schedule.interval }
        : { delayMinutes: record.schedule.delayMinutes }),
    schedule: undefined as never
  }))
  for (const entry of persisted) {
    delete (entry as { schedule?: unknown }).schedule
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(persisted, null, 1), 'utf8')
  renameSync(tmp, path)
}

function adopt(entry: unknown, now: number): ZcodeAutomationRecord | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const raw = entry as Record<string, unknown>
  const schedule = scheduleOf(raw)
  if (schedule === null) {
    return null
  }
  const record: ZcodeAutomationRecord = {
    automationId: String(raw.automationId ?? ''),
    title: String(raw.title ?? ''),
    cronExpr: String(raw.cronExpr ?? ''),
    prompt: String(raw.prompt ?? ''),
    ...(typeof raw.modelSelection === 'string' ? { modelSelection: raw.modelSelection } : {}),
    ...(typeof raw.mode === 'string' ? { mode: raw.mode } : {}),
    ...(typeof raw.targetTaskId === 'string' ? { targetTaskId: raw.targetTaskId } : {}),
    ...(typeof raw.orcaSessionId === 'string' ? { orcaSessionId: raw.orcaSessionId } : {}),
    enabled: raw.enabled === true,
    lifecycleStatus:
      raw.lifecycleStatus === 'active' ||
      raw.lifecycleStatus === 'completed' ||
      raw.lifecycleStatus === 'failed' ||
      raw.lifecycleStatus === 'paused'
        ? raw.lifecycleStatus
        : 'failed',
    ...(typeof raw.nextRunAt === 'number' ? { nextRunAt: raw.nextRunAt } : {}),
    ...(typeof raw.lastRunAt === 'number' ? { lastRunAt: raw.lastRunAt } : {}),
    runCount: typeof raw.runCount === 'number' ? raw.runCount : 0,
    recurring: raw.recurring === true,
    ...(typeof raw.maxRuns === 'number' ? { maxRuns: raw.maxRuns } : {}),
    schedule
  }
  if (record.automationId.length === 0 || record.prompt.length === 0) {
    return null
  }
  reconcileMissed(record, now)
  return record
}

/** A run the host was closed for: fire it once within the grace window,
 *  otherwise advance to the next future occurrence. */
function reconcileMissed(record: ZcodeAutomationRecord, now: number): void {
  if (record.lifecycleStatus !== 'active' || record.nextRunAt === undefined) {
    return
  }
  if (record.nextRunAt > now) {
    return
  }
  if (now - record.nextRunAt <= GRACE_MS) {
    // Due now: the store's first tick fires it.
    return
  }
  const due = nextAfter(record.schedule, now)
  record.nextRunAt = due === null ? undefined : due
  if (record.nextRunAt === undefined) {
    record.lifecycleStatus = 'completed'
  }
}

function nextAfter(schedule: ZcodeAutomationSchedule, now: number): number | null {
  if (schedule.kind === 'relative') {
    return null
  }
  if (schedule.kind === 'interval') {
    const unitMs =
      schedule.unit === 'minute'
        ? MINUTE
        : schedule.unit === 'hour'
          ? HOUR
          : schedule.unit === 'day'
            ? DAY
            : schedule.unit === 'week'
              ? 7 * DAY
              : schedule.unit === 'month'
                ? 30 * DAY
                : 365 * DAY
    return now + schedule.interval * unitMs
  }
  // A cron beyond grace: step minute-by-minute to its next match (UTC).
  const at = new Date(now - (now % MINUTE) + MINUTE)
  for (let guard = 0; guard < 366 * 24 * 60; guard += 1) {
    if (cronMatchesLoose(schedule.expr, at)) {
      return at.getTime()
    }
    at.setUTCMinutes(at.getUTCMinutes() + 1)
  }
  return null
}

function cronMatchesLoose(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    return false
  }
  return (
    fieldLoose(fields[0]!, at.getUTCMinutes(), 0) &&
    fieldLoose(fields[1]!, at.getUTCHours(), 0) &&
    fieldLoose(fields[2]!, at.getUTCDate(), 1) &&
    fieldLoose(fields[3]!, at.getUTCMonth() + 1, 1) &&
    fieldLoose(fields[4]!.replace(/7/g, '0'), at.getUTCDay(), 0)
  )
}

function fieldLoose(field: string, value: number, low: number): boolean {
  if (field === '*') {
    return true
  }
  for (const part of field.split(',')) {
    const step = part.includes('/') ? Number(part.split('/')[1]) : 1
    const range = part.includes('/') ? part.split('/')[0] : part
    if (step < 1) {
      continue
    }
    if (range === '*') {
      if ((value - low) % step === 0) {
        return true
      }
      continue
    }
    const bits = range.split('-').map(Number)
    if (bits.some((bit) => !Number.isInteger(bit))) {
      continue
    }
    const from = bits[0]!
    const to = bits.length === 2 ? bits[1]! : bits[0]!
    if (value >= from && value <= to && (value - from) % step === 0) {
      return true
    }
  }
  return false
}

function scheduleOf(raw: Record<string, unknown>): ZcodeAutomationSchedule | null {
  const kind = raw.scheduleKind
  if (kind === 'cron' && typeof raw.cronExpr === 'string') {
    return { kind: 'cron', expr: raw.cronExpr }
  }
  if (
    kind === 'interval' &&
    typeof raw.intervalUnit === 'string' &&
    typeof raw.interval === 'number'
  ) {
    const unitRaw = raw.intervalUnit.toLowerCase()
    const unit = unitRaw.endsWith('ly')
      ? unitRaw.slice(0, -2)
      : unitRaw.endsWith('s')
        ? unitRaw.slice(0, -1)
        : unitRaw
    return { kind: 'interval', unit: unit as 'minute', interval: raw.interval }
  }
  if (kind === 'relative' && typeof raw.delayMinutes === 'number') {
    return { kind: 'relative', delayMinutes: raw.delayMinutes }
  }
  return readZcodeSchedule(raw) as ZcodeAutomationSchedule
}
