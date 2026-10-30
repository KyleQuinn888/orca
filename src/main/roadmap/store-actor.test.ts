// D5: 4-writer barrier test — the single store actor must serialize all
// mutations and the final file must reflect every writer's change.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStoreActor } from './store-actor'

describe('D5: single-writer store actor', () => {
  it('4 concurrent writers: all mutations land, final file reflects every writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actor-'))
    const actor = createStoreActor(dir)

    // 4 writers mutate different sessions concurrently
    const writers = [1, 2, 3, 4].map(async (i) => {
      await actor.mutate((state) => {
        state.policy[`sess-${i}`] = 'eligible'
        state.metrics[`sess-${i}`] = { turns: i * 10, edits: i * 5, files: [], fileCount: i }
      })
    })

    // a 5th writer mutates an EXISTING entry mid-flight (cross-writer dependency)
    const crossWriter = actor.mutate((state) => {
      state.policy['sess-1'] = 'excluded' // flips writer 1's result
    })

    await Promise.all([...writers, crossWriter])

    // verify in-memory state
    const final = actor.read()
    expect(final.policy['sess-1']).toBe('excluded') // cross-writer won (last write)
    expect(final.policy['sess-2']).toBe('eligible')
    expect(final.policy['sess-3']).toBe('eligible')
    expect(final.policy['sess-4']).toBe('eligible')

    // verify the FILE on disk matches the in-memory state (no lost writes)
    const onDisk = JSON.parse(readFileSync(join(dir, 'roadmap-state.json'), 'utf8')) as {
      policy: Record<string, string>
    }
    expect(onDisk.policy['sess-1']).toBe('excluded')
    expect(onDisk.policy['sess-2']).toBe('eligible')
    expect(onDisk.policy['sess-3']).toBe('eligible')
    expect(onDisk.policy['sess-4']).toBe('eligible')

    rmSync(dir, { recursive: true, force: true })
  })

  it('mutations are strictly serialized (later sees earlier)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actor-'))
    const actor = createStoreActor(dir)
    const order: number[] = []

    await Promise.all([
      actor.mutate(() => {
        order.push(1)
      }),
      actor.mutate(() => {
        order.push(2)
      }),
      actor.mutate(() => {
        order.push(3)
      }),
      actor.mutate(() => {
        order.push(4)
      })
    ])

    expect(JSON.stringify(order)).toBe(JSON.stringify([1, 2, 3, 4]))
    rmSync(dir, { recursive: true, force: true })
  })

  it('a throwing mutation does not break the chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actor-'))
    const actor = createStoreActor(dir)

    await actor
      .mutate(() => {
        throw new Error('intentional')
      })
      .catch(() => {})
    await actor.mutate((state) => {
      state.policy['sess-ok'] = 'eligible'
    })

    expect(actor.read().policy['sess-ok']).toBe('eligible')
    rmSync(dir, { recursive: true, force: true })
  })
})
