import { describe, expect, it } from 'vitest'

import {
  cronToRrule,
  readZcodeSchedule,
  zcodeAutomationScheduleToOrca
} from './zcode-automation-schedule'

const NOW = Date.UTC(2026, 9, 22, 12, 34, 56)

describe('zcode automation schedules as RRULE', () => {
  it('maps the plain recurring shapes the model writes', () => {
    expect(cronToRrule('* * * * *', NOW)).toMatchObject({ rrule: 'FREQ=HOURLY' })
    expect(cronToRrule('*/20 * * * *', NOW)).toMatchObject({
      rrule: 'FREQ=HOURLY;BYMINUTE=0,20,40'
    })
    expect(cronToRrule('30 * * * *', NOW)).toMatchObject({ rrule: 'FREQ=HOURLY;BYMINUTE=30' })
    expect(cronToRrule('0 9 * * *', NOW)).toMatchObject({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
    expect(cronToRrule('0,30 9,18 * * *', NOW)).toMatchObject({
      rrule: 'FREQ=DAILY;BYHOUR=9,18;BYMINUTE=0,30'
    })
    expect(cronToRrule('0 9 * * 1-5', NOW)).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0'
    })
    expect(cronToRrule('0 9 * * mon,wed', NOW)).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0'
    })
  })

  it('anchors at the hour boundary so the first occurrence is ahead', () => {
    const { dtstart } = cronToRrule('* * * * *', NOW)
    expect(dtstart % 3_600_000).toBe(0)
  })

  it('refuses the shapes RRULE cannot name, instead of approximating', () => {
    expect(() => cronToRrule('0 9 1 * mon', NOW)).toThrow()
    expect(() => cronToRrule('0 9 * * sat-sun', NOW)).toThrow()
    expect(() => cronToRrule('* * * * * *', NOW)).toThrow()
    expect(() => cronToRrule('5-10/2 * * * *', NOW)).toThrow()
  })

  it('carries intervals and one-shot delays', () => {
    expect(
      zcodeAutomationScheduleToOrca({ kind: 'interval', unit: 'minute', interval: 20 }, NOW)
    ).toMatchObject({ rrule: 'FREQ=MINUTELY;INTERVAL=20' })
    expect(
      zcodeAutomationScheduleToOrca({ kind: 'interval', unit: 'day', interval: 2 }, NOW)
    ).toMatchObject({ rrule: 'FREQ=DAILY;INTERVAL=2' })
    expect(
      zcodeAutomationScheduleToOrca({ kind: 'relative', delayMinutes: 30 }, NOW)
    ).toMatchObject({ rrule: 'FREQ=DAILY;COUNT=1', dtstart: NOW + 30 * 60_000 })
  })

  it('reads the create params schedule carriers in their precedence', () => {
    expect(readZcodeSchedule({ relativeDelayMinutes: 5, cronExpr: '* * * * *' })).toEqual({
      kind: 'relative',
      delayMinutes: 5
    })
    expect(readZcodeSchedule({ intervalUnit: 'minutes', interval: 10 })).toEqual({
      kind: 'interval',
      unit: 'minute',
      interval: 10
    })
    expect(readZcodeSchedule({ cronExpr: '0 9 * * *' })).toEqual({
      kind: 'cron',
      expr: '0 9 * * *'
    })
    expect(readZcodeSchedule({})).toEqual({ kind: 'cron', expr: '* * * * *' })
  })
})
