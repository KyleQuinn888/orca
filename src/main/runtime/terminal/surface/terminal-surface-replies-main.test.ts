import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID
} from '../../orca-runtime-test-fixtures.spec'
import {
  SURFACE_PTYS,
  SURFACE_TAB_ID,
  captureSurfaceReplies,
  recordedSurfaceReplies,
  surfaceRuntime
} from './terminal-surface-replies.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const golden = (name: string): string =>
  recordedSurfaceReplies(path.join(__dirname, '__fixtures__', name))

const MOUNTED = Object.keys(SURFACE_PTYS).map((leafId, index) => ({
  tabId: SURFACE_TAB_ID,
  leafId,
  paneRuntimeId: index + 1,
  paneTitle: null
}))

// Layout-owner build: main answers from its own layout and terminal bindings.
describe('terminal replies from main (switch on)', () => {
  it('match the window-owned build when the window sends only what it mounts', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })

    expect(await captureSurfaceReplies(runtime)).toBe(
      golden('terminal-surface-replies-desktop.json')
    )
  })

  it('list the saved panes with no window, under their saved tab', async () => {
    const { runtime } = surfaceRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.terminals.map(({ tabId, leafId, ptyId, title, connected }) => ({
        tabId,
        leafId,
        ptyId,
        title,
        connected
      }))
    ).toEqual([
      {
        tabId: SURFACE_TAB_ID,
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-a',
        title: 'Persisted Terminal',
        connected: true
      },
      {
        tabId: SURFACE_TAB_ID,
        leafId: HEADLESS_SECOND_LEAF_ID,
        ptyId: 'pty-b',
        title: 'Persisted Terminal',
        connected: true
      }
    ])
    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'ready',
      liveTabCount: 1,
      liveLeafCount: 2
    })
  })

  it('answer before any window has published', async () => {
    const { runtime } = surfaceRuntime()

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(listed.terminals.map((terminal) => terminal.leafId)).toEqual([
      HEADLESS_LEAF_ID,
      HEADLESS_SECOND_LEAF_ID
    ])
    const shown = await runtime.showTerminal(listed.terminals[0]!.handle)
    expect(shown).toMatchObject({ tabId: SURFACE_TAB_ID, ptyId: 'pty-a', paneRuntimeId: -1 })
  })
})
