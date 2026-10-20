// One desktop scenario and the replies CLI, paired desktops and orcad read about it, normalised so
// a switch-off capture and a switch-on run compare byte for byte.
import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-test-fixtures.spec'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'

export const SURFACE_TAB_ID = '33333333-3333-4333-8333-333333333333'
export const SURFACE_PTYS = { [HEADLESS_LEAF_ID]: 'pty-a', [HEADLESS_SECOND_LEAF_ID]: 'pty-b' }

type Runtime = InstanceType<typeof OrcaRuntimeService>

/** A saved tab split in two, each pane bound to a live terminal. */
export function surfaceRuntime(): {
  runtime: Runtime
  store: ReturnType<typeof makeRuntimeStoreWithWorkspaceSession>
} {
  const layout = makeHeadlessTerminalLayout(SURFACE_PTYS)
  const harness = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: SURFACE_TAB_ID,
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: SURFACE_TAB_ID },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: SURFACE_TAB_ID,
            ptyId: 'pty-a',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Persisted Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: { [SURFACE_TAB_ID]: layout }
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared runtime spec fixture store implements every method these paths call.
  const runtime = new OrcaRuntimeService(harness.runtimeStore as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () =>
      Object.values(SURFACE_PTYS).map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
    )
  })
  const internals = runtime as unknown as {
    recordPtyWorktree: (ptyId: string, worktreeId: string, state?: Record<string, unknown>) => void
  }
  for (const ptyId of Object.values(SURFACE_PTYS)) {
    internals.recordPtyWorktree(ptyId, TEST_WORKTREE_ID, { connected: true })
  }
  return { runtime, store: harness }
}

/** Today's window graph for the scenario: both panes mounted. */
export function mountedSurfaceGraph(): RuntimeSyncWindowGraph {
  const layout = makeHeadlessTerminalLayout(SURFACE_PTYS)
  return {
    tabs: [
      {
        tabId: SURFACE_TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: 'Persisted Terminal',
        activeLeafId: HEADLESS_LEAF_ID,
        layout: layout.root
      }
    ],
    leaves: Object.entries(SURFACE_PTYS).map(([leafId, ptyId], index) => ({
      tabId: SURFACE_TAB_ID,
      worktreeId: TEST_WORKTREE_ID,
      leafId,
      paneRuntimeId: index + 1,
      ptyId,
      paneTitle: null,
      title: 'Persisted Terminal'
    }))
  }
}

/** Handles are minted at random; each is replaced by its first-seen position. */
function normaliseHandles(value: unknown): unknown {
  const names = new Map<string, string>()
  return JSON.parse(JSON.stringify(value), (key, field) => {
    if ((key === 'handle' || key === 'terminal') && typeof field === 'string') {
      const name = names.get(field) ?? `handle-${names.size + 1}`
      names.set(field, name)
      return name
    }
    return field
  })
}

/** Every reply the scenario's readers get, in one JSON document. */
export async function captureSurfaceReplies(runtime: Runtime): Promise<string> {
  const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  const shown = []
  for (const terminal of listed.terminals) {
    shown.push(await runtime.showTerminal(terminal.handle))
  }
  const status = runtime.getStatus()
  return JSON.stringify(
    normaliseHandles({
      list: listed,
      show: shown,
      status: {
        graphStatus: status.graphStatus,
        liveTabCount: status.liveTabCount,
        liveLeafCount: status.liveLeafCount
      }
    })
  )
}

/** A recorded reply, in the exact bytes JSON.stringify gives the wire (the file is formatted). */
export function recordedSurfaceReplies(file: string): string {
  return JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))
}
