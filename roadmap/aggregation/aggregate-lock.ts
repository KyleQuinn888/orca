// Aggregate lock — spec layer-002-003 v7.3
// Whole-run lease (Step 0-5) + 60s heartbeat + fencing epoch:
// stale takeover bumps the epoch; every write carries and re-checks it.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// ─── Aggregate lock: lease + heartbeat + fencing epoch ──────────────────

const LOCK_HEARTBEAT_MS = 60_000

export class AggregateLock {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  readonly epoch: number

  private constructor(
    private readonly lockPath: string,
    epoch: number
  ) {
    this.epoch = epoch
  }

  static acquire(roadmap002Dir: string, opts: { staleMs?: number } = {}): AggregateLock {
    // Preempt threshold must exceed max aggregation duration (spec: max(3600s, budget))
    const staleMs = opts.staleMs ?? Math.max(3_600_000, 0)
    const lockPath = join(roadmap002Dir, '.aggregate.lock')
    mkdirSync(roadmap002Dir, { recursive: true })
    let takeWithEpoch = 1
    if (existsSync(lockPath)) {
      try {
        const prev = JSON.parse(readFileSync(lockPath, 'utf8')) as {
          epoch: number
          heartbeatAt: number
        }
        const age = Date.now() - prev.heartbeatAt
        if (age < staleMs) {
          throw new Error(
            `aggregate lock held (epoch ${prev.epoch}, heartbeat ${Math.round(age / 1000)}s ago); retry later`
          )
        }
        takeWithEpoch = prev.epoch + 1 // stale takeover bumps epoch — old holder's writes will be rejected
      } catch (e) {
        if ((e as Error).message.startsWith('aggregate lock held')) {
          throw e
        }
        // unreadable lock file: treat as stale, epoch bump unknown -> use time-based epoch
        takeWithEpoch = Date.now()
      }
    }
    const lock = new AggregateLock(lockPath, takeWithEpoch)
    lock.writeHeartbeat()
    lock.heartbeatTimer = setInterval(() => {
      // Only the current epoch holder may refresh the heartbeat (spec)
      try {
        const cur = JSON.parse(readFileSync(lockPath, 'utf8')) as { epoch: number }
        if (cur.epoch === lock.epoch) {
          lock.writeHeartbeat()
        }
      } catch {
        /* lock file gone or unreadable: stop refreshing */
      }
    }, LOCK_HEARTBEAT_MS)
    ;(lock.heartbeatTimer as unknown as { unref?: () => void }).unref?.()
    return lock
  }

  private writeHeartbeat(): void {
    const tmp = `${this.lockPath}.tmp`
    writeFileSync(tmp, JSON.stringify({ epoch: this.epoch, heartbeatAt: Date.now() }), 'utf8')
    renameSync(tmp, this.lockPath)
  }

  /** Fencing check: every write must verify the lock still carries our epoch. */
  assertEpochCurrent(what: string): void {
    try {
      const cur = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { epoch: number }
      if (cur.epoch !== this.epoch) {
        throw new Error(
          `fencing rejection on ${what}: lock epoch moved ${this.epoch} -> ${cur.epoch}`
        )
      }
    } catch (e) {
      if ((e as Error).message.startsWith('fencing rejection')) {
        throw e
      }
      throw new Error(`fencing check failed on ${what}: ${(e as Error).message}`)
    }
  }

  release(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }
    this.heartbeatTimer = null
    try {
      const cur = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { epoch: number }
      if (cur.epoch === this.epoch) {
        unlinkSync(this.lockPath)
      }
    } catch {
      /* already gone or replaced — nothing to release */
    }
  }
}
