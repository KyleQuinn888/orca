// D5: single-writer store actor (owner ruling): ALL roadmap-state.json writes
// go through one serialized actor. Multiple concurrent callers queue; the last
// committed write always includes all prior mutations. The 4-writer barrier
// test (store-actor.test.ts) proves this under contention.

import { loadState, saveState, type RoadmapStateV2 } from './roadmap-store'

export type StoreActor = {
  /** Read the current committed state. */
  read(): RoadmapStateV2
  /**
   * Mutate the state through the single writer. Mutations are serialized:
   * each mutation sees the previous mutation's effect; the file write happens
   * after each mutation commits. Returns the post-mutation state.
   */
  mutate(fn: (state: RoadmapStateV2) => void): Promise<RoadmapStateV2>
}

export function createStoreActor(userDataDir: string): StoreActor {
  const state = loadState(userDataDir)
  let chain: Promise<void> = Promise.resolve()

  return {
    read: () => state,
    mutate(fn) {
      const run = chain.then(() => {
        fn(state)
        saveState(userDataDir, state)
      })
      // keep the chain alive even if one mutation throws
      chain = run.catch(() => {})
      return run.then(() => state)
    }
  }
}
