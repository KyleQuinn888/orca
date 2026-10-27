import { describe, expect, it } from 'vitest'

import { ZcodeAutomationStore } from './zcode-automation-store'

function store(fired: { prompt: string; at: number }[], clock: { now: number }) {
  return new ZcodeAutomationStore({
    fire: (automation) => fired.push({ prompt: automation.prompt, at: clock.now }),
    now: () => clock.now,
    running: () => true
  })
}

describe('ZcodeAutomationStore', () => {
  it('creates, lists, answers the binding and deletes', () => {
    const fired: { prompt: string; at: number }[] = []
    const clock = { now: 1_000_000_000_000 }
    const subject = store(fired, clock)
    const created = subject.create(
      {
        prompt: 'hi',
        title: 'greeter',
        cronExpr: '* * * * *',
        recurring: true,
        targetTaskId: 'sess_1'
      },
      'orca_1'
    )
    expect(created.lifecycleStatus).toBe('active')
    expect(created.recurring).toBe(true)
    expect(subject.list()).toHaveLength(1)
    expect(subject.boundTo('sess_1')).toBe(true)
    expect(subject.boundTo('sess_other')).toBe(false)
    expect(subject.delete(created.automationId)).toBe(true)
    expect(subject.list()).toHaveLength(0)
  })

  it('fires a one-shot relative delay once, then completes', () => {
    const fired: { prompt: string; at: number }[] = []
    const clock = { now: 1_000_000_000_000 }
    const subject = store(fired, clock)
    const created = subject.create(
      { prompt: 'tick', title: 'once', relativeDelayMinutes: 30, recurring: false },
      'orca_1'
    )
    expect(created.nextRunAt).toBe(clock.now + 30 * 60_000)
    subject.tickForTest()
    expect(fired).toHaveLength(0)
    clock.now += 31 * 60_000
    subject.tickForTest()
    expect(fired).toEqual([{ prompt: 'tick', at: clock.now }])
    const record = subject.list()[0]!
    expect(record.lifecycleStatus).toBe('completed')
    expect(record.runCount).toBe(1)
    expect(record.nextRunAt).toBeUndefined()
  })

  it('honours maxRuns on a recurring schedule', () => {
    const fired: { prompt: string; at: number }[] = []
    const clock = { now: 1_000_000_000_000 }
    const subject = store(fired, clock)
    subject.create(
      {
        prompt: 'again',
        title: 'twice',
        intervalUnit: 'minutes',
        interval: 5,
        recurring: true,
        maxRuns: 2
      },
      'orca_1'
    )
    clock.now += 6 * 60_000
    subject.tickForTest()
    clock.now += 6 * 60_000
    subject.tickForTest()
    expect(fired).toHaveLength(2)
    expect(subject.list()[0]!.lifecycleStatus).toBe('completed')
  })

  it('computes cron fires in UTC field order', () => {
    const fired: { prompt: string; at: number }[] = []
    const clock = { now: Date.UTC(2026, 9, 22, 12, 0, 1) }
    const subject = store(fired, clock)
    const created = subject.create(
      { prompt: 'at30', title: 'half past', cronExpr: '30 * * * *', recurring: true },
      'orca_1'
    )
    expect(created.nextRunAt).toBe(Date.UTC(2026, 9, 22, 12, 30, 0))
  })

  it('updates prompt and schedule', () => {
    const fired: { prompt: string; at: number }[] = []
    const clock = { now: Date.UTC(2026, 9, 22, 12, 0, 0) }
    const subject = store(fired, clock)
    const created = subject.create(
      { prompt: 'old', title: 't', cronExpr: '0 9 * * *', recurring: true },
      'orca_1'
    )
    const updated = subject.update(created.automationId, { prompt: 'new', cronExpr: '0 18 * * *' })
    expect(updated?.prompt).toBe('new')
    expect(updated?.nextRunAt).toBe(Date.UTC(2026, 9, 22, 18, 0, 0))
  })
})
