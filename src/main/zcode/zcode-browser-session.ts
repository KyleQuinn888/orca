import { randomUUID } from 'node:crypto'
import type { ZcodeSnapshot } from './zcode-browser-snapshot'

/** One zcode-addressed tab: a stable zcode tabId over one Orca browser page. */
export type ZcodeBrowserTab = {
  tabId: string
  /** The Orca browser page this tab drives; commands target it explicitly. */
  browserPageId: string
  /** Last navigation result's url/title; list/tab summaries read it between snapshots. */
  pageInfo: { url: string; title: string }
  /** Last snapshot taken on this tab; refs resolve against it until replaced. */
  snapshot: ZcodeSnapshot | null
  /**
   * Best-effort history depth: every navigate we relay increments it. SPA
   * pushState and in-page redirects escape the count, so back() can still be
   * attempted when canGoBack reads false — the flag only advises the agent.
   */
  navigationDepth: number
}

export type ZcodeBrowserSessionRecord = {
  tabs: Map<string, ZcodeBrowserTab>
  activeTabId: string | null
}

/**
 * Tab registry per zcode protocol session (the `sess_...` id on the wire).
 * The zcode agent model addresses tabs by OUR tabId; the mapping to Orca
 * browserPageIds lives only here.
 */
export class ZcodeBrowserSessionTabs {
  private readonly sessions = new Map<string, ZcodeBrowserSessionRecord>()

  record(sessionId: string): ZcodeBrowserSessionRecord {
    let record = this.sessions.get(sessionId)
    if (!record) {
      record = { tabs: new Map(), activeTabId: null }
      this.sessions.set(sessionId, record)
    }
    return record
  }

  registerTab(sessionId: string, browserPageId: string): ZcodeBrowserTab {
    const record = this.record(sessionId)
    for (const tab of record.tabs.values()) {
      if (tab.browserPageId === browserPageId) {
        // The same Orca page re-registered: keep one zcode tab id over it.
        record.activeTabId = tab.tabId
        return tab
      }
    }
    const tab: ZcodeBrowserTab = {
      tabId: `tab:${randomUUID()}`,
      browserPageId,
      pageInfo: { url: 'about:blank', title: '' },
      snapshot: null,
      navigationDepth: 0
    }
    record.tabs.set(tab.tabId, tab)
    record.activeTabId = tab.tabId
    return tab
  }

  /** The command's tabId, else the session's active tab, else null. */
  resolveTab(sessionId: string, tabId?: string): ZcodeBrowserTab | null {
    const record = this.sessions.get(sessionId)
    if (!record) {
      return null
    }
    if (tabId !== undefined) {
      return record.tabs.get(tabId) ?? null
    }
    const active = record.activeTabId ? record.tabs.get(record.activeTabId) : undefined
    return active ?? [...record.tabs.values()].at(-1) ?? null
  }

  activate(sessionId: string, tabId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record?.tabs.has(tabId)) {
      return false
    }
    record.activeTabId = tabId
    return true
  }

  dropTab(sessionId: string, tabId: string): void {
    const record = this.sessions.get(sessionId)
    if (!record) {
      return
    }
    record.tabs.delete(tabId)
    if (record.activeTabId === tabId) {
      record.activeTabId = [...record.tabs.keys()].at(-1) ?? null
    }
  }

  listTabs(sessionId: string): ZcodeBrowserTab[] {
    return [...(this.sessions.get(sessionId)?.tabs.values() ?? [])]
  }

  /** Session end: drop the record; Orca pages themselves are closed by callers. */
  releaseSession(sessionId: string): ZcodeBrowserTab[] {
    const record = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    return record ? [...record.tabs.values()] : []
  }

  releaseAll(): ZcodeBrowserTab[] {
    const tabs = [...this.sessions.values()].flatMap((record) => [...record.tabs.values()])
    this.sessions.clear()
    return tabs
  }
}
