import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID as THIRD_LEAF_ID,
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

  it('keep answering after the window closes', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })

    runtime.markGraphUnavailable(1)

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.terminals.map(({ tabId, leafId, orphaned, title }) => ({ tabId, leafId, orphaned, title }))
    ).toEqual(
      [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID].map((leafId) => ({
        tabId: SURFACE_TAB_ID,
        leafId,
        orphaned: false,
        title: 'Persisted Terminal'
      }))
    )
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveLeafCount: 2 })
    const shown = await runtime.showTerminal(listed.terminals[0]!.handle)
    expect(shown).toMatchObject({ tabId: SURFACE_TAB_ID, ptyId: 'pty-a', paneRuntimeId: -1 })
  })

  it('list a pane split into the layout before any window shows it', async () => {
    const { runtime, store, setSession } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
    const session = store.getSession()
    const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: {
          ...layout,
          root: {
            type: 'split',
            direction: 'vertical',
            first: layout.root!,
            second: { type: 'leaf', leafId: THIRD_LEAF_ID }
          },
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [THIRD_LEAF_ID]: 'pty-c' }
        }
      }
    })
    ;(runtime as unknown as { recordPtyWorktree: (id: string, wt: string, s: object) => void })
      .recordPtyWorktree('pty-c', TEST_WORKTREE_ID, { connected: true })
    await Promise.resolve()

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(listed.terminals.map((terminal) => terminal.ptyId)).toEqual(['pty-a', 'pty-b', 'pty-c'])
  })
})
