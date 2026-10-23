import { ZcodeBrowserSessionTabs } from './zcode-browser-session'
import { ZcodeBrowserCommandDispatcher } from './zcode-browser-commands'
import type { ZcodeBrowserCommandResult } from './zcode-browser-results'
import type { ZcodeBrowserSurfaceProvider } from './zcode-browser-surface'

/** browserBackendDescriptorSchema mirrored locally (strict on the wire). */
export type ZcodeBrowserBackendDescriptor = {
  id: string
  generation: number
  type: 'iab' | 'extension' | 'cdp'
  name: string
  capabilities: { browser?: { id: string; description: string }[]; tab?: unknown[] }
  apiSupportOverrides?: Record<string, boolean>
  metadata?: Record<string, string>
}

/**
 * Answers the ZCode Protocol's browser-use reverse requests by driving Orca's
 * own browser command surface. One instance per zcode adapter; the wire
 * sessions it sees are the provider's `sess_...` ids.
 */
export class ZcodeBrowserBackend {
  readonly browserId = 'orca:embedded-browser'
  private readonly tabs = new ZcodeBrowserSessionTabs()
  private readonly dispatcherCache = new WeakMap<object, ZcodeBrowserCommandDispatcher>()

  constructor(private readonly surfaceProvider: ZcodeBrowserSurfaceProvider) {}

  /** interaction/browserList: the one backend this host can offer, or none. */
  list(): { browsers: ZcodeBrowserBackendDescriptor[] } {
    const surface = this.resolveSurface()
    if (!surface) {
      return { browsers: [] }
    }
    return { browsers: [this.descriptor()] }
  }

  /** interaction/browserExecute; malformed envelopes answer backend_unavailable. */
  async execute(params: unknown): Promise<ZcodeBrowserCommandResult> {
    const startedAt = Date.now()
    const envelope = params as {
      sessionId?: unknown
      browserId?: unknown
      browserGeneration?: unknown
      command?: unknown
    }
    const surface = this.resolveSurface()
    if (!surface) {
      return {
        ok: false,
        error: {
          code: 'backend_unavailable',
          message: 'No browser backend is available on this host'
        },
        elapsedMs: Date.now() - startedAt
      }
    }
    if (
      typeof envelope.sessionId !== 'string' ||
      !envelope.sessionId ||
      envelope.browserId !== this.browserId ||
      typeof envelope.command !== 'object' ||
      envelope.command === null
    ) {
      return {
        ok: false,
        error: {
          code: 'backend_unavailable',
          message: 'Browser request envelope is not addressable to this backend'
        },
        elapsedMs: Date.now() - startedAt
      }
    }
    const generation =
      typeof envelope.browserGeneration === 'number' && envelope.browserGeneration >= 0
        ? envelope.browserGeneration
        : 0
    const dispatcher = this.dispatcherFor(surface)
    return dispatcher.execute({
      sessionId: envelope.sessionId,
      browserId: this.browserId,
      browserGeneration: generation,
      command: envelope.command as Record<string, unknown>
    })
  }

  /** Provider session end: close the Orca pages it opened and forget the tabs. */
  async releaseSession(providerSessionId: string): Promise<void> {
    const surface = this.resolveSurface()
    const tabs = this.tabs.releaseSession(providerSessionId)
    if (!surface) {
      return
    }
    await Promise.allSettled(
      tabs.map((tab) => surface.browserTabClose({ page: tab.browserPageId }))
    )
  }

  /** Host teardown: nothing should survive the adapter that opened the pages. */
  async releaseAll(): Promise<void> {
    const surface = this.resolveSurface()
    const tabs = this.tabs.releaseAll()
    if (!surface) {
      return
    }
    await Promise.allSettled(
      tabs.map((tab) => surface.browserTabClose({ page: tab.browserPageId }))
    )
  }

  private descriptor(): ZcodeBrowserBackendDescriptor {
    return {
      id: this.browserId,
      generation: 0,
      type: 'cdp',
      name: 'Orca Browser',
      capabilities: { browser: [], tab: [] },
      apiSupportOverrides: {
        'BrowserUser.openTabs': false,
        'BrowserUser.history': false,
        'PlaywrightAPI.waitForEvent': false,
        'PlaywrightDownload.path': false,
        'PlaywrightFileChooser.setFiles': false,
        'PlaywrightLocator.downloadMedia': false,
        'PlaywrightLocator.evaluate': false,
        'CUAAPI.downloadMedia': false,
        'DomCUAAPI.downloadMedia': false
      },
      metadata: {
        provider: 'orca',
        launchMode: 'embedded',
        headless: 'false'
      }
    }
  }

  private resolveSurface() {
    try {
      return this.surfaceProvider() ?? null
    } catch {
      return null
    }
  }

  private dispatcherFor(surface: NonNullable<ReturnType<ZcodeBrowserBackend['resolveSurface']>>) {
    let dispatcher = this.dispatcherCache.get(surface as object)
    if (!dispatcher) {
      dispatcher = new ZcodeBrowserCommandDispatcher(surface, this.tabs, {
        browserId: this.browserId,
        browserGeneration: 0
      })
      this.dispatcherCache.set(surface as object, dispatcher)
    }
    return dispatcher
  }
}

/**
 * The adapter's thin routing hook: keeps wire-shape details out of the session
 * adapter, whose line budget is tight. Execute settles asynchronously — the
 * reply lands when the Orca command does.
 */
export function answerZcodeBrowserWireRequest(
  backend: ZcodeBrowserBackend | undefined,
  request: { id: number | string; method: string; params: unknown },
  connection: {
    respond: (id: number | string, result: unknown) => void
    respondWithError: (id: number | string, code: number, message: string) => void
  }
): void {
  if (request.method === 'interaction/browserList') {
    connection.respond(request.id, backend ? backend.list() : { browsers: [] })
    return
  }
  if (!backend) {
    connection.respondWithError(request.id, -32001, 'no browser backend in this host')
    return
  }
  void backend.execute(request.params).then(
    (result) => connection.respond(request.id, result),
    (error: unknown) =>
      connection.respondWithError(
        request.id,
        -32001,
        `browser backend failed: ${error instanceof Error ? error.message : String(error)}`
      )
  )
}
