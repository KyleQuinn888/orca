import type { ZcodeBrowserCommandSurface } from './zcode-browser-surface'
import type { ZcodeBrowserSessionTabs, ZcodeBrowserTab } from './zcode-browser-session'
import type { ZcodePageState, ZcodeSnapshotElement } from './zcode-browser-snapshot'
import { ZcodeBrowserTabCommands } from './zcode-browser-tab-commands'
import {
  zcodeBrowserErrorResult,
  zcodeBrowserUnsupported,
  zcodeTabSummary,
  type ZcodeBrowserCommandResult,
  type ZcodeBrowserErrorResult,
  type ZcodeBrowserMeta
} from './zcode-browser-results'

/** Orca BrowserError codes → the zcode contract's closed error-code set. */
function mapSurfaceError(error: unknown): ZcodeBrowserErrorResult {
  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'browser_timeout') {
    return { code: 'timeout', message }
  }
  if (code === 'browser_unavailable') {
    return { code: 'backend_unavailable', message }
  }
  return { code: 'execution_error', message }
}

export type ZcodeBrowserDispatchInput = {
  sessionId: string
  browserId: string
  browserGeneration: number
  command: Record<string, unknown>
}

/**
 * One BrowserCommand executed against the Orca surface. The zcode server
 * validates the returned JSON; unknown/malformed commands answer structured
 * errors rather than throwing so the agent loop can carry on.
 */
export class ZcodeBrowserCommandDispatcher extends ZcodeBrowserTabCommands {
  constructor(
    private readonly surface: ZcodeBrowserCommandSurface,
    private readonly tabs: ZcodeBrowserSessionTabs,
    private readonly identity: { browserId: string; browserGeneration: number }
  ) {
    super()
  }

  protected writeSurface(): ZcodeBrowserCommandSurface {
    return this.surface
  }

  protected async surfaceEval(expression: string, page: string): Promise<{ result: string }> {
    return this.surface.browserEval({ expression, page })
  }

  protected async surfaceScreenshot(
    fullPage: boolean,
    page: string
  ): Promise<{ data: string; format: 'png' | 'jpeg' }> {
    return fullPage
      ? this.surface.browserFullScreenshot({ format: 'png', page })
      : this.surface.browserScreenshot({ format: 'png', page })
  }

  protected resolveRef(tab: ZcodeBrowserTab, ref: string): ZcodeSnapshotElement | null {
    return tab.snapshot?.elements.find((element) => element.ref === ref) ?? null
  }

  protected requireTab(sessionId: string, tabId: string | undefined): ZcodeBrowserTab | null {
    return this.tabs.resolveTab(sessionId, tabId)
  }

  protected tabRegistry(): ZcodeBrowserSessionTabs {
    return this.tabs
  }

  protected browserIdentity(): { browserId: string; browserGeneration: number } {
    return this.identity
  }

  protected metaFor(sessionId: string, tab: ZcodeBrowserTab): ZcodeBrowserMeta {
    return this.buildMeta({ sessionId, ...this.identity }, tab)
  }

  async execute(input: ZcodeBrowserDispatchInput): Promise<ZcodeBrowserCommandResult> {
    const startedAt = Date.now()
    const { command } = input
    const method = typeof command.method === 'string' ? command.method : ''
    const tabId = typeof command.tabId === 'string' ? command.tabId : undefined
    try {
      switch (method) {
        case 'list':
          return this.list(input, startedAt)
        case 'listUserTabs':
          // This backend owns every tab it exposes; no human tabs to claim.
          return { ok: true, userTabs: [], elapsedMs: Date.now() - startedAt }
        case 'newTab':
          return await this.newTab(input, startedAt)
        case 'activateTab':
          return await this.activateTab(input, command.tabId, startedAt)
        case 'close':
          return await this.close(input, tabId, startedAt)
        case 'navigate':
          return await this.navigate(input, tabId, command.url, startedAt)
        case 'back':
          return await this.traverse(input, tabId, 'back', startedAt)
        case 'forward':
          return await this.traverse(input, tabId, 'forward', startedAt)
        case 'reload':
          return await this.traverse(input, tabId, 'reload', startedAt)
        case 'getState':
          return await this.getState(input.sessionId, tabId, startedAt)
        case 'snapshot':
          return await this.snapshot(input.sessionId, tabId, command, startedAt)
        case 'screenshot':
          return await this.screenshot(input.sessionId, tabId, command, startedAt)
        case 'click':
        case 'fill':
        case 'type':
        case 'press':
        case 'cuaKeypress':
        case 'scroll':
        case 'cuaScroll':
        case 'domCuaScroll':
        case 'hover':
        case 'select':
        case 'check':
        case 'drag':
        case 'cuaDrag':
          return await this.writeCommand(method, input, tabId, command, startedAt)
        case 'elementInfo':
          return await this.withTab(input.sessionId, tabId, startedAt, (tab) =>
            this.elementInfo(tab, command, startedAt)
          )
        case 'evaluate':
          return await this.withTab(input.sessionId, tabId, startedAt, (tab) =>
            this.evaluate(tab, command, startedAt)
          )
        case 'waitFor':
          return await this.withTab(input.sessionId, tabId, startedAt, (tab) =>
            this.waitFor(tab, command, startedAt)
          )
        case 'playwright':
          return await this.withTab(input.sessionId, tabId, startedAt, (tab) =>
            this.playwrightAction(input.sessionId, tab, command, startedAt)
          )
        case 'playwrightWaitForTimeout':
          return await this.playwrightWaitForTimeout(command, startedAt)
        case 'turnEnded':
          // Lifecycle ping the broker relays at turn end; no work to do here.
          return { ok: true, elapsedMs: Date.now() - startedAt }
        default:
          return zcodeBrowserUnsupported(method, startedAt)
      }
    } catch (error) {
      return zcodeBrowserErrorResult(mapSurfaceError(error), startedAt)
    }
  }

  /** Tab-scoped write commands: every family member takes (sessionId, tab, …). */
  private readonly writers: Record<
    string,
    (
      sessionId: string,
      tab: ZcodeBrowserTab,
      command: Record<string, unknown>,
      startedAt: number
    ) => Promise<ZcodeBrowserCommandResult>
  > = {
    click: (sessionId, tab, command, startedAt) => this.click(sessionId, tab, command, startedAt),
    fill: (sessionId, tab, command, startedAt) => this.fill(sessionId, tab, command, startedAt),
    type: (sessionId, tab, command, startedAt) => this.type(sessionId, tab, command, startedAt),
    press: (sessionId, tab, command, startedAt) => this.press(sessionId, tab, command, startedAt),
    cuaKeypress: (sessionId, tab, command, startedAt) =>
      this.cuaKeypress(sessionId, tab, command, startedAt),
    scroll: (sessionId, tab, command, startedAt) => this.scroll(sessionId, tab, command, startedAt),
    cuaScroll: (sessionId, tab, command, startedAt) =>
      this.cuaScroll(sessionId, tab, command, startedAt),
    domCuaScroll: (sessionId, tab, command, startedAt) =>
      this.domCuaScroll(sessionId, tab, command, startedAt),
    hover: (sessionId, tab, command, startedAt) => this.hover(sessionId, tab, command, startedAt),
    select: (sessionId, tab, command, startedAt) => this.select(sessionId, tab, command, startedAt),
    check: (sessionId, tab, command, startedAt) => this.check(sessionId, tab, command, startedAt),
    drag: (sessionId, tab, command, startedAt) => this.drag(sessionId, tab, command, startedAt),
    cuaDrag: (sessionId, tab, command, startedAt) =>
      this.cuaDrag(sessionId, tab, command, startedAt)
  }

  private async writeCommand(
    method: string,
    input: ZcodeBrowserDispatchInput,
    tabId: string | undefined,
    command: Record<string, unknown>,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    const writer = this.writers[method]
    return this.withTab(input.sessionId, tabId, startedAt, (tab) =>
      writer(input.sessionId, tab, command, startedAt)
    )
  }

  private withTab<T>(
    sessionId: string,
    tabId: string | undefined,
    startedAt: number,
    run: (tab: ZcodeBrowserTab) => Promise<T> | T
  ): Promise<T | ZcodeBrowserCommandResult> {
    const tab = this.tabs.resolveTab(sessionId, tabId)
    if (!tab) {
      return Promise.resolve(
        zcodeBrowserErrorResult(
          { code: 'ref_not_found', message: 'Browser tab is unavailable' },
          startedAt
        )
      )
    }
    return Promise.resolve(run(tab))
  }

  private async navigate(
    input: ZcodeBrowserDispatchInput,
    tabId: string | undefined,
    rawUrl: unknown,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
    const urlAllowed = /^https?:\/\//u.test(url) || url === 'about:blank'
    if (!url || !urlAllowed) {
      return zcodeBrowserErrorResult(
        { code: 'navigation_blocked', message: `Navigation URL is not allowed: ${String(rawUrl)}` },
        startedAt
      )
    }
    const tab = this.tabs.resolveTab(input.sessionId, tabId)
    if (!tab) {
      return this.implicitNewTabNavigate(input, url, startedAt)
    }
    const result = await this.surface.browserGoto({ url, page: tab.browserPageId })
    tab.pageInfo = { url: result.url, title: result.title }
    tab.navigationDepth += 1
    return this.navigationResult(input, tab, startedAt)
  }

  /** navigate with no tab: the managed-CDP contract creates the default tab. */
  private async implicitNewTabNavigate(
    input: ZcodeBrowserDispatchInput,
    url: string,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    const created = await this.surface.browserTabCreate({ url })
    const tab = this.tabs.registerTab(input.sessionId, created.browserPageId)
    tab.navigationDepth = url === 'about:blank' ? 0 : 1
    return {
      ok: true,
      state: await this.readState(tab),
      tab: zcodeTabSummary(tab, true),
      meta: this.buildMeta(input, tab),
      elapsedMs: Date.now() - startedAt
    }
  }

  private async traverse(
    input: ZcodeBrowserDispatchInput,
    tabId: string | undefined,
    direction: 'back' | 'forward' | 'reload',
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    const tab = this.tabs.resolveTab(input.sessionId, tabId)
    if (!tab) {
      return zcodeBrowserErrorResult(
        { code: 'ref_not_found', message: 'Browser tab is unavailable' },
        startedAt
      )
    }
    const params = { page: tab.browserPageId }
    // browserForward is typed unknown on the surface; the page answers {url,title}.
    const traversed =
      direction === 'back'
        ? await this.surface.browserBack(params)
        : direction === 'forward'
          ? ((await this.surface.browserForward(params)) as { url: string; title: string })
          : await this.surface.browserReload(params)
    tab.pageInfo = { url: traversed.url, title: traversed.title }
    if (direction === 'back' && tab.navigationDepth > 0) {
      tab.navigationDepth -= 1
    }
    if (direction === 'forward') {
      tab.navigationDepth += 1
    }
    return this.navigationResult(input, tab, startedAt)
  }

  private async navigationResult(
    input: ZcodeBrowserDispatchInput,
    tab: ZcodeBrowserTab,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult & { state: ZcodePageState }> {
    return {
      ok: true,
      state: await this.readState(tab),
      meta: this.buildMeta(input, tab),
      elapsedMs: Date.now() - startedAt
    }
  }
}
