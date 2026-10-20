// Layout-owner builds: the runtime graph carries main's own panes for every workspace main owns,
// and main republishes them when the Store's layout changes, whether or not a window publishes.
// Only switch-on code reaches this module, so a window-owned build bundles none of it.

import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'
import type { RuntimeStore } from '../../runtime-store-contract'
import {
  composeMainTerminalSurfaces,
  TerminalSurfaceIndex,
  type MainTerminalSurfaces
} from './terminal-surface-index'

export type MainTerminalSurfacesHost = {
  store: () => Pick<
    RuntimeStore,
    'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'onWorkspaceSessionWritten' | 'getSettings'
  > | null
  homeHostId: (key: string) => ExecutionHostId | null
  /** The graph authority now, when its graph is ready; null otherwise. */
  readyGraphPublisher: () => number | null
  /** Installs a graph under the publisher's authority, as the window's own publication does. */
  publish: (windowId: number, graph: RuntimeSyncWindowGraph) => void
}

class MainSurfacePublisher {
  private readonly index: TerminalSurfaceIndex
  /** The window's last graph: its mount facts and the panes of workspaces main does not own. */
  private lastWindowGraph: { windowId: number; graph: RuntimeSyncWindowGraph } | null = null
  /** The main surfaces the last installed graph carried. */
  private installed: MainTerminalSurfaces | null = null
  private scheduled = false

  constructor(private readonly host: MainTerminalSurfacesHost) {
    this.index = new TerminalSurfaceIndex({
      store: host.store,
      homeHostId: host.homeHostId,
      generatedTitlesEnabled: () => host.store()?.getSettings?.().tabAutoGenerateTitle === true,
      onChanged: () => this.schedule()
    })
  }

  /** The graph a publisher installs: main's panes in place of the window's for what main owns. */
  withMainSurfaces(windowId: number, graph: RuntimeSyncWindowGraph): RuntimeSyncWindowGraph {
    this.index.start()
    this.lastWindowGraph = { windowId, graph }
    this.installed = this.index.surfaces()
    return composeMainTerminalSurfaces(graph, this.installed)
  }

  /** Installs main's panes under the current authority, with that publisher's last mount facts. */
  republish(opts: { force?: boolean } = {}): void {
    const windowId = this.host.readyGraphPublisher()
    if (windowId === null || (!opts.force && this.index.surfaces() === this.installed)) {
      return
    }
    const last = this.lastWindowGraph?.windowId === windowId ? this.lastWindowGraph.graph : null
    // Only the terminal list: the window's session rows and grid sizes were taken when it sent them.
    this.host.publish(windowId, {
      tabs: last?.tabs ?? [],
      leaves: last?.leaves ?? [],
      ...(last?.mountedLeaves ? { mountedLeaves: last.mountedLeaves } : {})
    })
  }

  /** A Store write may have moved a pane; main's panes are installed once per task. */
  private schedule(): void {
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.republish()
    })
  }
}

const byRuntime = new WeakMap<object, MainSurfacePublisher>()

/** The runtime's publisher of main's panes, made on its first graph. */
export function mainTerminalSurfaces(
  runtime: object,
  host: () => MainTerminalSurfacesHost
): MainSurfacePublisher {
  let state = byRuntime.get(runtime)
  if (!state) {
    state = new MainSurfacePublisher(host())
    byRuntime.set(runtime, state)
  }
  return state
}

/** The runtime's publisher when it has installed a graph; null before that. */
export function startedMainTerminalSurfaces(runtime: object): MainSurfacePublisher | null {
  return byRuntime.get(runtime) ?? null
}
