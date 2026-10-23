import type { ZcodeBrowserSessionTabs, ZcodeBrowserTab } from './zcode-browser-session'
import { ZcodeBrowserProbeCommands } from './zcode-browser-probe-commands'
import {
  zcodeBrowserErrorResult,
  zcodeTabSummary,
  type ZcodeBrowserCommandResult,
  type ZcodeBrowserMeta
} from './zcode-browser-results'

/**
 * The tab-lifecycle layer: list/newTab/activateTab/close over the session's
 * tab registry, plus the meta builder every family reuses.
 */
export abstract class ZcodeBrowserTabCommands extends ZcodeBrowserProbeCommands {
  protected abstract tabRegistry(): ZcodeBrowserSessionTabs

  protected abstract browserIdentity(): { browserId: string; browserGeneration: number }

  protected buildMeta(
    input: { sessionId: string; browserId: string; browserGeneration: number },
    tab?: ZcodeBrowserTab | null
  ): ZcodeBrowserMeta {
    return {
      browserUse: true,
      backendType: 'cdp',
      browserId: input.browserId,
      browserGeneration: input.browserGeneration,
      openTabIds: this.tabRegistry()
        .listTabs(input.sessionId)
        .map((entry) => entry.tabId),
      ...(tab ? { tabId: tab.tabId, currentUrl: tab.pageInfo.url, lifecycle: 'active' } : {})
    }
  }

  protected list(input: { sessionId: string }, startedAt: number): ZcodeBrowserCommandResult {
    const tabs = this.tabRegistry()
    const all = tabs.listTabs(input.sessionId)
    const activeId = tabs.resolveTab(input.sessionId)?.tabId ?? null
    return {
      ok: true,
      tabs: all.map((tab) => zcodeTabSummary(tab, tab.tabId === activeId)),
      meta: this.buildMeta({ ...input, ...this.browserIdentity() }),
      elapsedMs: Date.now() - startedAt
    }
  }

  protected async newTab(
    input: { sessionId: string },
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    const created = await this.writeSurface().browserTabCreate({ url: 'about:blank' })
    const tab = this.tabRegistry().registerTab(input.sessionId, created.browserPageId)
    return {
      ok: true,
      tab: zcodeTabSummary(tab, true),
      meta: this.buildMeta({ ...input, ...this.browserIdentity() }, tab),
      elapsedMs: Date.now() - startedAt
    }
  }

  protected async activateTab(
    input: { sessionId: string },
    rawTabId: unknown,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    const tabId = typeof rawTabId === 'string' ? rawTabId : ''
    const tab = this.tabRegistry().resolveTab(input.sessionId, tabId)
    if (!tab) {
      return zcodeBrowserErrorResult(
        { code: 'ref_not_found', message: `Browser tab '${tabId}' is unavailable` },
        startedAt
      )
    }
    await this.writeSurface().browserTabShow({ page: tab.browserPageId })
    this.tabRegistry().activate(input.sessionId, tab.tabId)
    return {
      ok: true,
      tab: zcodeTabSummary(tab, true),
      meta: this.buildMeta({ ...input, ...this.browserIdentity() }, tab),
      elapsedMs: Date.now() - startedAt
    }
  }

  protected async close(
    input: { sessionId: string },
    tabId: string | undefined,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    const tab = this.tabRegistry().resolveTab(input.sessionId, tabId)
    if (!tab) {
      return zcodeBrowserErrorResult(
        { code: 'ref_not_found', message: 'Browser tab is unavailable' },
        startedAt
      )
    }
    await this.writeSurface().browserTabClose({ page: tab.browserPageId })
    this.tabRegistry().dropTab(input.sessionId, tab.tabId)
    return {
      ok: true,
      meta: this.buildMeta({ ...input, ...this.browserIdentity() }),
      elapsedMs: Date.now() - startedAt
    }
  }
}
