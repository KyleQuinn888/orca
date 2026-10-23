// The zcode automation/* answers, step two of the bridge: a store the wire
// contract reads and a timer that fires the bound session's prompt while the
// host runs. Records follow the wire shape the runtime validated against.

import { readZcodeSchedule, type ZcodeAutomationSchedule } from './zcode-automation-schedule'

export type ZcodeAutomationRecord = {
  automationId: string
  title: string
  cronExpr: string
  prompt: string
  modelSelection?: string
  mode?: string
  targetTaskId?: string
  orcaSessionId?: string
  enabled: boolean
  lifecycleStatus: 'active' | 'completed' | 'failed' | 'paused'
  nextRunAt?: number
  lastRunAt?: number
  runCount: number
  recurring: boolean
  maxRuns?: number
  schedule: ZcodeAutomationSchedule
}

export type ZcodeAutomationFire = (automation: ZcodeAutomationRecord) => void

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TICK_MS = 15_000

function fieldMatches(field: string, value: number, low: number): boolean {
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
    const from = bits.length === 2 ? bits[0]! : bits[0]!
    const to = bits.length === 2 ? bits[1]! : bits[0]!
    if (value >= from && value <= to && (value - from) % step === 0) {
      return true
    }
  }
  return false
}

function cronMatches(expr: string, at: Date): boolean {
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/)
  if (!minute || !hour || !dom || !month || !dow) {
    return false
  }
  if (
    !fieldMatches(minute, at.getUTCMinutes(), 0) ||
    !fieldMatches(hour, at.getUTCHours(), 0) ||
    !fieldMatches(dom, at.getUTCDate(), 1) ||
    !fieldMatches(month, at.getUTCMonth() + 1, 1)
  ) {
    return false
  }
  const anyDayConstraint = dom !== '*' || dow !== '*'
  if (!anyDayConstraint) {
    return true
  }
  // Cron's day fields are a union: dom OR dow (dow 0 and 7 both name Sunday).
  const domHit = dom !== '*' && fieldMatches(dom, at.getUTCDate(), 1)
  const dowHit = dow !== '*' && fieldMatches(dow.replace(/7/g, '0'), at.getUTCDay(), 0)
  return domHit || dowHit
}

function nextFire(schedule: ZcodeAutomationSchedule, after: number): number | null {
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
    return after + schedule.interval * unitMs
  }
  const expr = schedule.expr
  const start = new Date(after - (after % MINUTE) + MINUTE)
  for (let at = start.getTime(), guard = 0; guard < 366 * 24 * 60; at += MINUTE, guard += 1) {
    if (cronMatches(expr, new Date(at))) {
      return at
    }
  }
  return null
}

/** The automation/* answers with a store and a fire timer, host-lifetime only. */
export class ZcodeAutomationStore {
  private readonly automations = new Map<string, ZcodeAutomationRecord>()
  private timer: ReturnType<typeof setInterval> | null = null
  private seq = 0

  constructor(
    private readonly deps: {
      fire: ZcodeAutomationFire
      now?: () => number
      /** Fires wait for this; absent (a test) means every fire is due at once. */
      running?: () => boolean
      /** Whole-store persistence: read adopts persisted records, write saves on change. */
      persistence?: {
        read(): ZcodeAutomationRecord[] | null
        write(records: readonly ZcodeAutomationRecord[]): void
      }
    }
  ) {
    const persisted = deps.persistence?.read()
    if (persisted) {
      for (const record of persisted) {
        this.automations.set(record.automationId, record)
        this.seq += 1
      }
    }
  }

  create(
    params: {
      cronExpr?: string
      relativeDelayMinutes?: number
      intervalUnit?: string
      interval?: number
      prompt: string
      title: string
      modelSelection?: string
      mode?: string
      targetTaskId?: string
      recurring?: boolean
      maxRuns?: number
    },
    orcaSessionId: string | undefined
  ): ZcodeAutomationRecord {
    const schedule = readZcodeSchedule(params)
    const now = (this.deps.now ?? Date.now)()
    const record: ZcodeAutomationRecord = {
      automationId: `zcAuto_${Date.now().toString(36)}_${(this.seq += 1)}`,
      title: params.title,
      cronExpr:
        schedule.kind === 'cron'
          ? schedule.expr
          : schedule.kind === 'interval'
            ? `every ${params.interval} ${params.intervalUnit ?? schedule.unit}s`
            : `once in ${params.relativeDelayMinutes}m`,
      prompt: params.prompt,
      ...(params.modelSelection !== undefined ? { modelSelection: params.modelSelection } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.targetTaskId !== undefined ? { targetTaskId: params.targetTaskId } : {}),
      ...(orcaSessionId !== undefined ? { orcaSessionId } : {}),
      enabled: true,
      lifecycleStatus: 'active',
      runCount: 0,
      recurring: params.recurring ?? (schedule.kind === 'interval' || schedule.kind === 'cron'),
      ...(params.maxRuns !== undefined ? { maxRuns: params.maxRuns } : {}),
      schedule
    }
    const due =
      schedule.kind === 'relative' ? now + schedule.delayMinutes * MINUTE : nextFire(schedule, now)
    if (due !== null) {
      record.nextRunAt = due
    } else {
      record.lifecycleStatus = 'failed'
    }
    this.automations.set(record.automationId, record)
    this.deps.persistence?.write(this.list())
    this.ensureTimer()
    return record
  }

  list(): ZcodeAutomationRecord[] {
    return [...this.automations.values()]
  }

  update(
    automationId: string,
    changes: {
      title?: string
      cronExpr?: string
      prompt?: string
      recurring?: boolean
      maxRuns?: number | null
      intervalUnit?: string
      interval?: number
    }
  ): ZcodeAutomationRecord | null {
    const record = this.automations.get(automationId)
    if (!record) {
      return null
    }
    if (changes.title !== undefined) {
      record.title = changes.title
    }
    if (changes.prompt !== undefined) {
      record.prompt = changes.prompt
    }
    if (changes.recurring !== undefined) {
      record.recurring = changes.recurring
    }
    if (changes.maxRuns === null) {
      delete record.maxRuns
    } else if (changes.maxRuns !== undefined) {
      record.maxRuns = changes.maxRuns
    }
    const reschedule =
      changes.cronExpr !== undefined ||
      changes.intervalUnit !== undefined ||
      changes.interval !== undefined
    if (reschedule) {
      record.schedule = readZcodeSchedule({
        cronExpr:
          changes.cronExpr ?? (record.schedule.kind === 'cron' ? record.schedule.expr : undefined),
        intervalUnit:
          changes.intervalUnit ??
          (record.schedule.kind === 'interval' ? record.schedule.unit : undefined),
        interval:
          changes.interval ??
          (record.schedule.kind === 'interval' ? record.schedule.interval : undefined)
      })
      const now = (this.deps.now ?? Date.now)()
      const due = record.schedule.kind === 'relative' ? null : nextFire(record.schedule, now)
      if (due !== null) {
        record.nextRunAt = due
      }
    }
    this.deps.persistence?.write(this.list())
    return record
  }

  delete(automationId: string): boolean {
    const deleted = this.automations.delete(automationId)
    if (deleted) {
      this.deps.persistence?.write(this.list())
    }
    return deleted
  }

  boundTo(targetTaskId: string): boolean {
    return this.list().some(
      (record) => record.targetTaskId === targetTaskId && record.lifecycleStatus === 'active'
    )
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null || (this.deps.running !== undefined && !this.deps.running())) {
      return
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  /** Test hook: one scheduler pass, independent of the timer. */
  tickForTest(): void {
    this.tick()
  }

  private tick(): void {
    const now = (this.deps.now ?? Date.now)()
    let firedAny = false
    for (const record of this.automations.values()) {
      if (
        !record.enabled ||
        record.lifecycleStatus !== 'active' ||
        record.nextRunAt === undefined
      ) {
        continue
      }
      if (record.nextRunAt > now) {
        continue
      }
      record.lastRunAt = now
      record.runCount += 1
      firedAny = true
      try {
        this.deps.fire(record)
      } catch {
        record.lifecycleStatus = 'failed'
        continue
      }
      if (
        !record.recurring ||
        (record.maxRuns !== undefined && record.runCount >= record.maxRuns)
      ) {
        record.lifecycleStatus = 'completed'
        record.nextRunAt = undefined
        continue
      }
      const due = nextFire(record.schedule, now)
      record.nextRunAt = due === null ? undefined : due
    }
    if (firedAny) {
      this.deps.persistence?.write(this.list())
    }
  }
}
