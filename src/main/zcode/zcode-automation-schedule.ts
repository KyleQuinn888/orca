// zcode's automation schedule vocabulary (a five-field cron, an interval with
// a unit, or a one-shot relative delay) as Orca's scheduler expression: an
// RFC RRULE string with a dtstart anchor. Pure conversion, honestly refusing
// the shapes RRULE cannot name.

export type ZcodeAutomationSchedule =
  | { kind: 'relative'; delayMinutes: number }
  | {
      kind: 'interval'
      unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
      interval: number
    }
  | { kind: 'cron'; expr: string }

/** The shapes Orca's scheduler runs: an RRULE plus its anchor instant. */
export type OrcaAutomationSchedule = { rrule: string; dtstart: number }

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const CRON_FIELD_COUNT = 5
const RRULE_UNSUPPORTED = 'This schedule has no faithful RRULE form; ask for a simpler one'

const DOW_BY_NAME: Readonly<Record<string, string>> = {
  sun: 'SU',
  mon: 'MO',
  tue: 'TU',
  wed: 'WE',
  thu: 'TH',
  fri: 'FR',
  sat: 'SA',
  '0': 'SU',
  '1': 'MO',
  '2': 'TU',
  '3': 'WE',
  '4': 'TH',
  '5': 'FR',
  '6': 'SA',
  '7': 'SU'
}

function parseIntegerField(field: string, low: number, high: number): number[] | null {
  if (field === '*') {
    return null
  }
  const values: number[] = []
  for (const part of field.split(',')) {
    const step = part.includes('/') ? Number(part.split('/')[1]) : 1
    const range = part.includes('/') ? part.split('/')[0] : part
    let from = low
    let to = high
    if (range !== '*') {
      const bits = range.split('-')
      const parsed = bits.map(Number)
      if (parsed.some((value) => !Number.isInteger(value))) {
        throw new Error(RRULE_UNSUPPORTED)
      }
      if (bits.length === 2) {
        ;[from, to] = parsed as [number, number]
      } else {
        from = to = parsed[0] as number
      }
      if (step > 1 && bits.length === 2) {
        throw new Error(RRULE_UNSUPPORTED)
      }
    }
    for (let value = from; value <= to; value += step) {
      if (value < low || value > high) {
        throw new Error(RRULE_UNSUPPORTED)
      }
      values.push(value)
    }
  }
  return values
}

function parseDowField(field: string): string[] | null {
  if (field === '*') {
    return null
  }
  const order = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
  const ordinal = (token: string): number => {
    const key = token.trim().toLowerCase()
    const byName = order.indexOf(DOW_BY_NAME[key] ?? '')
    if (byName !== -1) {
      return byName
    }
    const numeric = Number(key)
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 7 ? numeric % 7 : -1
  }
  const ordinals: number[] = []
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      throw new Error(RRULE_UNSUPPORTED)
    }
    const bits = part.split('-')
    const parsed = bits.map(ordinal)
    if (parsed.some((value) => value === -1)) {
      throw new Error(RRULE_UNSUPPORTED)
    }
    if (bits.length === 2) {
      if (parsed[1]! <= parsed[0]!) {
        throw new Error(RRULE_UNSUPPORTED)
      }
      for (let value = parsed[0]!; value <= parsed[1]!; value += 1) {
        ordinals.push(value)
      }
    } else {
      ordinals.push(parsed[0]!)
    }
  }
  return [...new Set(ordinals)].map((value) => order[value]!)
}

/**
 * A five-field cron as an RRULE. The faithful subset: minute/hour lists (with
 * plain steps), day-of-week names, and — as the only day-level fields — plain
 * day-of-month and month lists. Cron's dom-OR-dow union has no RRULE form and
 * is refused rather than approximated.
 */
export function cronToRrule(expr: string, now: number): OrcaAutomationSchedule {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new Error(RRULE_UNSUPPORTED)
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields
  const minutes = parseIntegerField(minuteField, 0, 59)
  const hours = parseIntegerField(hourField, 0, 23)
  const doms = parseIntegerField(domField, 1, 31)
  const months = parseIntegerField(monthField, 1, 12)
  const dows = parseDowField(dowField)
  if ((doms !== null || months !== null) && dows !== null) {
    throw new Error(RRULE_UNSUPPORTED)
  }
  const parts: string[] = []
  if (months !== null) {
    parts.push(`FREQ=YEARLY;BYMONTH=${months.join(',')}`)
  } else if (doms !== null) {
    parts.push('FREQ=YEARLY')
  } else if (dows !== null) {
    parts.push(`FREQ=WEEKLY;BYDAY=${[...new Set(dows)].join(',')}`)
  } else if (hours === null) {
    // No hour constraint: the minute pattern repeats within every hour.
    parts.push('FREQ=HOURLY')
  } else {
    parts.push('FREQ=DAILY')
  }
  if (months !== null) {
    // BYMONTHDAY only carries meaning next to BYMONTH or on YEARLY.
  }
  if (doms !== null) {
    parts.push(`BYMONTHDAY=${doms.join(',')}`)
  }
  if (hours !== null) {
    parts.push(`BYHOUR=${hours.join(',')}`)
  }
  if (minutes !== null) {
    parts.push(`BYMINUTE=${minutes.join(',')}`)
  } else if (hours === null) {
    // Every minute: the hourly rule with no BYMINUTE already means that.
  }
  // Anchor at the current hour boundary: the first occurrence the scheduler
  // computes is then the next matching instant, never one in the past.
  const dtstart = now - (now % HOUR)
  return { rrule: parts.join(';'), dtstart }
}

/** An interval (every N minutes/hours/…) and a one-shot delay as RRULEs. */
export function zcodeAutomationScheduleToOrca(
  schedule: ZcodeAutomationSchedule,
  now: number
): OrcaAutomationSchedule {
  if (schedule.kind === 'relative') {
    return { rrule: 'FREQ=DAILY;COUNT=1', dtstart: now + schedule.delayMinutes * MINUTE }
  }
  if (schedule.kind === 'interval') {
    const freq =
      schedule.unit === 'minute'
        ? 'MINUTELY'
        : schedule.unit === 'hour'
          ? 'HOURLY'
          : schedule.unit === 'day'
            ? 'DAILY'
            : schedule.unit === 'week'
              ? 'WEEKLY'
              : schedule.unit === 'month'
                ? 'MONTHLY'
                : 'YEARLY'
    return { rrule: `FREQ=${freq};INTERVAL=${schedule.interval}`, dtstart: now - (now % MINUTE) }
  }
  return cronToRrule(schedule.expr, now)
}

/** The create params' schedule carriers as one discriminated schedule. */
export function readZcodeSchedule(params: {
  relativeDelayMinutes?: number
  intervalUnit?: string
  interval?: number
  cronExpr?: string
}): ZcodeAutomationSchedule {
  if (typeof params.relativeDelayMinutes === 'number') {
    return { kind: 'relative', delayMinutes: params.relativeDelayMinutes }
  }
  if (
    typeof params.intervalUnit === 'string' &&
    typeof params.interval === 'number' &&
    params.interval >= 1
  ) {
    const raw = params.intervalUnit.toLowerCase()
    const unit = raw.endsWith('ly') ? raw.slice(0, -2) : raw.endsWith('s') ? raw.slice(0, -1) : raw
    return { kind: 'interval', unit: unit as 'minute', interval: params.interval }
  }
  return { kind: 'cron', expr: params.cronExpr ?? '* * * * *' }
}
