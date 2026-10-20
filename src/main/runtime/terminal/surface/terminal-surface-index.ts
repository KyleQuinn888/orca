// Layout-owner builds: the terminal tabs and panes of every workspace main owns, read from the
// Store's layout and pane bindings rather than from the window's graph. A paired server's
// workspaces (`runtime:<env>` partitions) are not here: the window still mirrors those.

import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeSyncWindowGraph
} from '../../../../shared/runtime-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { projectRuntimeSurfaces } from '../../runtime-leaf-record-projection'
import type { RuntimeStore } from '../../runtime-store-contract'

type SurfaceStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'onWorkspaceSessionWritten'
>

type LoadedPartition = Pick<LoadedWorkspaceLayout, 'layout' | 'desktopView' | 'facts'>

/** Main's terminal surfaces, in the window graph's shape so the graph's readers take them as is. */
export type MainTerminalSurfaces = {
  tabs: RuntimeSyncedTab[]
  /** A pane with no mounted view has no renderer pane id: -1, as other main-made leaves. */
  leaves: RuntimeSyncedLeaf[]
  /** Every workspace main answers for, a workspace with no terminal tab included. */
  worktreeIds: ReadonlySet<string>
}

export class TerminalSurfaceIndex {
  private readonly loaded = new Map<ExecutionHostId, LoadedPartition>()
  private dirty: Set<ExecutionHostId> | 'all' = 'all'
  private stopWatching: (() => void) | null = null
  private started = false
  private current: MainTerminalSurfaces | null = null
  private currentJson = ''

  constructor(
    private readonly deps: {
      store: () => SurfaceStore | null
      /** The partition that owns a workspace key; null when none does. */
      homeHostId: (key: string) => ExecutionHostId | null
      generatedTitlesEnabled: () => boolean
      /** Main's surfaces may have changed; they are read again on the next `surfaces()`. */
      onChanged: () => void
    }
  ) {}

  /** Watches the Store's writes; idempotent, and a no-op until the runtime has a store. */
  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.stopWatching =
      this.deps.store()?.onWorkspaceSessionWritten?.((hostId) => this.markDirty(hostId)) ?? null
    this.markDirty(null)
  }

  stop(): void {
    this.stopWatching?.()
    this.stopWatching = null
    this.started = false
  }

  /** True while a Store write has not yet been read into `surfaces()`. */
  isDirty(): boolean {
    return this.dirty === 'all' || this.dirty.size > 0
  }

  surfaces(): MainTerminalSurfaces {
    if (this.current && !this.isDirty()) {
      return this.current
    }
    const dirty = this.dirty
    this.dirty = new Set()
    const next = this.project(dirty)
    const json = JSON.stringify({ tabs: next.tabs, leaves: next.leaves })
    // The same object when nothing changed, so a write that moves no pane installs nothing.
    if (!this.current || json !== this.currentJson) {
      this.current = next
      this.currentJson = json
    }
    return this.current
  }

  private markDirty(hostId: ExecutionHostId | null): void {
    if (hostId === null) {
      this.dirty = 'all'
    } else if (this.dirty !== 'all') {
      this.dirty.add(hostId)
    }
    this.deps.onChanged()
  }

  private project(dirty: Set<ExecutionHostId> | 'all'): MainTerminalSurfaces {
    const store = this.deps.store()
    const hostIds = (store?.getWorkspaceSessionHostIds?.() ?? []).filter(
      (hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime'
    )
    for (const hostId of [...this.loaded.keys()]) {
      if (!hostIds.includes(hostId)) {
        this.loaded.delete(hostId)
      }
    }
    for (const hostId of hostIds) {
      if (dirty !== 'all' && !dirty.has(hostId) && this.loaded.has(hostId)) {
        continue
      }
      const session = store?.getWorkspaceSession?.(hostId)
      if (session) {
        this.loaded.set(hostId, loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext()))
      } else {
        this.loaded.delete(hostId)
      }
    }
    const partitions: LoadedPartition[] = []
    const worktreeIds = new Set<string>()
    for (const [hostId, loaded] of this.loaded) {
      // Only the owning partition's copy counts; a stray copy elsewhere is not a second pane.
      const workspaces = Object.fromEntries(
        Object.entries(loaded.layout.workspaces).filter(
          ([key]) => this.homeOf(key) === hostId
        )
      )
      for (const workspace of Object.values(workspaces)) {
        worktreeIds.add(workspace.worktreeId)
      }
      partitions.push({ ...loaded, layout: { ...loaded.layout, workspaces } })
    }
    const { tabs, panes } = projectRuntimeSurfaces(partitions, this.deps.generatedTitlesEnabled())
    return {
      tabs: [...tabs.values()],
      leaves: panes.map(({ tab, worktreeId, leafId, ptyId, liveTitle }) => ({
        tabId: tab.entityId,
        worktreeId,
        leafId,
        paneRuntimeId: -1,
        ptyId,
        paneTitle: null,
        title: tabs.get(tab.entityId)?.title ?? liveTitle
      })),
      worktreeIds
    }
  }

  private homeOf(key: string): ExecutionHostId | null {
    try {
      return this.deps.homeHostId(key)
    } catch {
      // A workspace the router cannot place is not guessed: no partition answers for it.
      return null
    }
  }
}

/**
 * The window's graph with main's panes in place of the window's own list for every workspace main
 * owns. A pane the window shows takes its renderer pane id and title; any other is parked, as a
 * live pane the window does not mount is today.
 */
export function composeMainTerminalSurfaces(
  graph: RuntimeSyncWindowGraph,
  main: MainTerminalSurfaces
): RuntimeSyncWindowGraph {
  const mounted = new Map(
    (graph.mountedLeaves ?? []).map((leaf) => [`${leaf.tabId}::${leaf.leafId}`, leaf])
  )
  const notMain = (surface: { worktreeId: string }): boolean =>
    !main.worktreeIds.has(surface.worktreeId)
  return {
    ...graph,
    tabs: [...graph.tabs.filter(notMain), ...main.tabs],
    leaves: [
      ...graph.leaves.filter(notMain),
      ...main.leaves.map((leaf) => {
        const shown = mounted.get(`${leaf.tabId}::${leaf.leafId}`)
        if (!shown) {
          return { ...leaf, parked: true }
        }
        return {
          ...leaf,
          paneRuntimeId: shown.paneRuntimeId,
          paneTitle: shown.paneTitle ?? null,
          ...(shown.parked ? { parked: true } : {})
        }
      })
    ]
  }
}
