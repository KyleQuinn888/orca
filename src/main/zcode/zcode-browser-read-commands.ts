import type { ZcodeBrowserTab } from './zcode-browser-session'
import {
  parseZcodeSnapshotEval,
  zcodeSnapshotExpression,
  type ZcodePageState,
  type ZcodeSnapshot
} from './zcode-browser-snapshot'
import {
  zcodeBrowserErrorResult,
  zcodeBrowserUnsupported,
  zcodePageStateFrom,
  type ZcodeBrowserMeta
} from './zcode-browser-results'

/** Strip collector extras: the wire snapshot schema is strict, extras would fail it. */
function wireSnapshot(snapshot: ZcodeSnapshot): ZcodeSnapshot {
  return {
    url: snapshot.url,
    title: snapshot.title,
    ...(snapshot.dom ? { dom: snapshot.dom } : {}),
    ...(snapshot.domTruncated !== undefined ? { domTruncated: snapshot.domTruncated } : {}),
    elements: snapshot.elements,
    truncated: snapshot.truncated
  }
}

/**
 * The read half of the dispatcher: state/snapshot/screenshot all run the in-page
 * collector through browserEval, so one evaluation feeds the tab's ref table.
 * The concrete dispatcher below supplies the surface and registry hooks.
 */
export abstract class ZcodeBrowserReadCommands {
  protected abstract requireTab(
    sessionId: string,
    tabId: string | undefined
  ): ZcodeBrowserTab | null

  protected abstract surfaceEval(expression: string, page: string): Promise<{ result: string }>

  protected abstract surfaceScreenshot(
    fullPage: boolean,
    page: string
  ): Promise<{ data: string; format: 'png' | 'jpeg' }>

  protected abstract metaFor(sessionId: string, tab: ZcodeBrowserTab): ZcodeBrowserMeta

  async getState(
    sessionId: string,
    tabId: string | undefined,
    startedAt: number
  ): Promise<{ ok: boolean; state?: ZcodePageState; meta?: ZcodeBrowserMeta; elapsedMs: number }> {
    const tab = this.requireTab(sessionId, tabId)
    if (!tab) {
      return zcodeBrowserErrorResult(
        { code: 'ref_not_found', message: 'Browser tab is unavailable' },
        startedAt
      )
    }
    return {
      ok: true,
      state: await this.readState(tab),
      meta: this.metaFor(sessionId, tab),
      elapsedMs: Date.now() - startedAt
    }
  }

  async snapshot(
    sessionId: string,
    tabId: string | undefined,
    command: Record<string, unknown>,
    startedAt: number
  ): Promise<{
    ok: boolean
    snapshot?: ZcodeSnapshot
    meta?: ZcodeBrowserMeta
    elapsedMs: number
  }> {
    const tab = this.requireTab(sessionId, tabId)
    if (!tab) {
      return zcodeBrowserErrorResult(
        { code: 'ref_not_found', message: 'Browser tab is unavailable' },
        startedAt
      )
    }
    const snapshot = await this.collect(tab, command)
    return {
      ok: true,
      snapshot: wireSnapshot(snapshot),
      meta: this.metaFor(sessionId, tab),
      elapsedMs: Date.now() - startedAt
    }
  }

  async screenshot(
    sessionId: string,
    tabId: string | undefined,
    command: Record<string, unknown>,
    startedAt: number
  ): Promise<{
    ok: boolean
    image?: { base64: string; mimeType: 'image/png' }
    meta?: ZcodeBrowserMeta
    elapsedMs: number
  }> {
    const tab = this.requireTab(sessionId, tabId)
    if (!tab) {
      return zcodeBrowserErrorResult(
        { code: 'ref_not_found', message: 'Browser tab is unavailable' },
        startedAt
      )
    }
    if (command.ref !== undefined || command.clip !== undefined) {
      return zcodeBrowserUnsupported('screenshot(ref|clip)', startedAt)
    }
    const captured = await this.surfaceScreenshot(command.fullPage === true, tab.browserPageId)
    if (captured.format !== 'png') {
      return zcodeBrowserErrorResult(
        { code: 'execution_error', message: 'Only PNG screenshots are supported' },
        startedAt
      )
    }
    return {
      ok: true,
      image: { base64: captured.data, mimeType: 'image/png' },
      meta: this.metaFor(sessionId, tab),
      elapsedMs: Date.now() - startedAt
    }
  }

  /** Runs the collector and caches it as the tab's ref table. */
  protected async collect(
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>
  ): Promise<ZcodeSnapshot> {
    const expression = zcodeSnapshotExpression({
      maxElements:
        typeof command.maxElements === 'number' && command.maxElements > 0
          ? command.maxElements
          : undefined,
      includeHidden: command.includeHidden === true
    })
    const evaluated = await this.surfaceEval(expression, tab.browserPageId)
    const snapshot = parseZcodeSnapshotEval(evaluated.result)
    if (!snapshot) {
      throw new Error(`Snapshot evaluation returned an unreadable result: ${evaluated.result}`)
    }
    tab.snapshot = snapshot
    tab.pageInfo = { url: snapshot.url, title: snapshot.title }
    return snapshot
  }

  protected async readState(tab: ZcodeBrowserTab): Promise<ZcodePageState> {
    const snapshot = await this.collect(tab, {})
    return zcodePageStateFrom(snapshot, tab.navigationDepth > 0, false)
  }
}
