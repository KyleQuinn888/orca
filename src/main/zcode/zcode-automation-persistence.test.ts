import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ZcodeAutomationStore, type ZcodeAutomationRecord } from './zcode-automation-store'
import { readZcodeAutomations, writeZcodeAutomations } from './zcode-automation-persistence'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function persistedStore(
  path: string,
  clock: { now: number },
  fired: ZcodeAutomationRecord[]
): ZcodeAutomationStore {
  return new ZcodeAutomationStore({
    fire: (record) => fired.push(record),
    now: () => clock.now,
    running: () => true,
    persistence: {
      read: () => readZcodeAutomations(path),
      write: (records) => writeZcodeAutomations(path, records)
    }
  })
}

describe('zcode automation persistence', () => {
  it('keeps created automations across a store restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-auto-persist-'))
    dirs.push(dir)
    const path = join(dir, 'automations.json')
    const clock = { now: Date.UTC(2026, 9, 23, 9, 0, 0) }
    const fired: ZcodeAutomationRecord[] = []
    const first = persistedStore(path, clock, fired)
    first.create(
      {
        prompt: 'hi',
        title: 'greeter',
        cronExpr: '30 * * * *',
        recurring: true,
        targetTaskId: 's1'
      },
      'orca_1'
    )
    const second = persistedStore(path, clock, fired)
    expect(second.list().map((record) => record.title)).toEqual(['greeter'])
    expect(second.boundTo('s1')).toBe(true)
  })

  it('returns null for a never-written file and [] for a malformed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-auto-empty-'))
    dirs.push(dir)
    expect(readZcodeAutomations(join(dir, 'none.json'))).toBeNull()
    const path = join(dir, 'bad.json')
    require('node:fs').writeFileSync(path, '{oops', 'utf8')
    expect(readZcodeAutomations(path)).toEqual([])
  })

  it('fires a run missed within the grace window after restart, skips an older one forward', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-auto-grace-'))
    dirs.push(dir)
    const path = join(dir, 'automations.json')
    // Anchored to the real clock adopt() reads: due 3 minutes ago stays due
    // (fires on the first tick); due 2 hours ago advances past the grace.
    const realNow = Date.now()
    writeZcodeAutomations(path, [
      {
        automationId: 'a_grace',
        title: 'grace',
        cronExpr: '* * * * *',
        prompt: 'soon',
        orcaSessionId: 'orca_1',
        enabled: true,
        lifecycleStatus: 'active',
        nextRunAt: realNow - 3 * 60_000,
        runCount: 0,
        recurring: true,
        schedule: { kind: 'interval', unit: 'minute', interval: 1 }
      },
      {
        automationId: 'a_stale',
        title: 'stale',
        cronExpr: '30 * * * *',
        prompt: 'late',
        orcaSessionId: 'orca_1',
        enabled: true,
        lifecycleStatus: 'active',
        nextRunAt: realNow - 2 * 3_600_000,
        runCount: 0,
        recurring: true,
        schedule: { kind: 'cron', expr: '30 * * * *' }
      }
    ])
    const fired: ZcodeAutomationRecord[] = []
    const store = persistedStore(path, { now: realNow }, fired)
    store.tickForTest()
    expect(fired.map((record) => record.automationId)).toEqual(['a_grace'])
    const stale = store.list().find((record) => record.automationId === 'a_stale')
    expect(stale?.nextRunAt).toBeDefined()
    expect(stale!.nextRunAt!).toBeGreaterThan(realNow)
  })
})
