import type { ZcodeBrowserTab } from './zcode-browser-session'
import type { ZcodePageState, ZcodeSnapshot } from './zcode-browser-snapshot'

/** browserTabSummarySchema mirrored locally; viewport defaults until a snapshot reads it. */
export const ZCODE_BROWSER_DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const

export type ZcodeTabSummary = {
  tabId: string
  url: string
  title: string
  viewport: { width: number; height: number }
  active?: boolean
  lifecycle?: 'active' | 'deliverable' | 'handoff'
}

export function zcodeTabSummary(tab: ZcodeBrowserTab, active: boolean): ZcodeTabSummary {
  const viewport = tab.snapshot
    ? {
        width: Math.round(tab.snapshot.viewportWidth ?? ZCODE_BROWSER_DEFAULT_VIEWPORT.width),
        height: Math.round(tab.snapshot.viewportHeight ?? ZCODE_BROWSER_DEFAULT_VIEWPORT.height)
      }
    : { ...ZCODE_BROWSER_DEFAULT_VIEWPORT }
  return {
    tabId: tab.tabId,
    url: tab.pageInfo.url,
    title: tab.pageInfo.title,
    viewport,
    ...(active ? { active: true } : {}),
    lifecycle: 'active'
  }
}

/** getState/navigation state from a collector result plus tracked depth flags. */
export function zcodePageStateFrom(
  snapshot: ZcodeSnapshot,
  canGoBack: boolean,
  canGoForward: boolean
): ZcodePageState {
  const state: ZcodePageState = {
    url: snapshot.url,
    title: snapshot.title,
    canGoBack,
    canGoForward
  }
  if (typeof snapshot.scrollX === 'number') {
    state.scrollX = snapshot.scrollX
  }
  if (typeof snapshot.scrollY === 'number') {
    state.scrollY = snapshot.scrollY
  }
  if (typeof snapshot.viewportWidth === 'number') {
    state.viewportWidth = snapshot.viewportWidth
  }
  if (typeof snapshot.viewportHeight === 'number') {
    state.viewportHeight = snapshot.viewportHeight
  }
  return state
}

export type ZcodeBrowserErrorResult = {
  code:
    | 'backend_unavailable'
    | 'capability_unsupported'
    | 'duplicate_request_id'
    | 'ref_not_found'
    | 'navigation_blocked'
    | 'timeout'
    | 'renderer_unreachable'
    | 'cancelled'
    | 'execution_error'
  message: string
  sideEffect?: 'none' | 'uncertain'
}

export type ZcodeBrowserMeta = {
  browserUse: true
  backendType: 'cdp'
  browserId: string
  browserGeneration: number
  openTabIds: string[]
  tabId?: string
  currentUrl?: string
  lifecycle?: 'active' | 'deliverable' | 'handoff' | 'closed'
}

/** The unified per-command result: browserCommandResultSchema mirrored locally. */
export type ZcodeBrowserCommandResult = {
  ok: boolean
  state?: ZcodePageState
  snapshot?: ZcodeSnapshot
  image?: { base64: string; mimeType: 'image/png' }
  tabs?: ZcodeTabSummary[]
  userTabs?: unknown[]
  tab?: ZcodeTabSummary
  value?: unknown
  element?: unknown
  dialog?: unknown
  recording?: unknown
  error?: ZcodeBrowserErrorResult
  meta?: ZcodeBrowserMeta
  elapsedMs: number
}

export function zcodeBrowserErrorResult(
  error: ZcodeBrowserErrorResult,
  startedAt: number
): ZcodeBrowserCommandResult {
  return { ok: false, error, elapsedMs: Date.now() - startedAt }
}

export function zcodeBrowserUnsupported(
  method: string,
  startedAt: number
): ZcodeBrowserCommandResult {
  return zcodeBrowserErrorResult(
    {
      code: 'capability_unsupported',
      message: `Browser command '${method}' is unavailable in the Orca browser backend`
    },
    startedAt
  )
}

/** A ref the last snapshot never minted, or one whose page has none cached. */
export function zcodeBrowserRefNotFound(
  ref: unknown,
  startedAt: number
): ZcodeBrowserCommandResult {
  return zcodeBrowserErrorResult(
    {
      code: 'ref_not_found',
      message: `Browser ref '${String(ref)}' is stale or unavailable. Take a fresh snapshot before retrying.`
    },
    startedAt
  )
}

/** An action that needs a target arrived with neither ref nor coordinates. */
export function zcodeBrowserMissingTarget(
  method: string,
  startedAt: number
): ZcodeBrowserCommandResult {
  return zcodeBrowserErrorResult(
    {
      code: 'execution_error',
      message: `Browser action requires a ref or x/y coordinates: ${method}`
    },
    startedAt
  )
}

/** Numeric command field with a fallback; NaN never reaches the page. */
export function zcodeBrowserNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
