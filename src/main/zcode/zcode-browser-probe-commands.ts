import type { ZcodeBrowserTab } from './zcode-browser-session'
import type { ZcodeSnapshot } from './zcode-browser-snapshot'
import { ZcodeBrowserPointerCommands } from './zcode-browser-pointer-commands'
import {
  zcodeBrowserErrorResult,
  zcodeBrowserMissingTarget,
  zcodeBrowserNumberOr,
  zcodeBrowserUnsupported,
  type ZcodeBrowserCommandResult
} from './zcode-browser-results'

const POLL_INTERVAL_MS = 150
const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 3_000
const PLAYWRIGHT_MAX_TIMEOUT_MS = 30_000

/** url matching for waitForURL: exact, or a `*` glob turned into a regex. */
function urlMatches(current: string, wanted: string): boolean {
  if (current === wanted) {
    return true
  }
  if (!wanted.includes('*')) {
    return false
  }
  const pattern = wanted.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
  return new RegExp(`^${pattern}$`, 'u').test(current)
}

/** Render the dom tree the way an aria snapshot reads: role "name": text lines. */
function ariaStyleSnapshot(snapshot: ZcodeSnapshot): string {
  const lines = [`- url: ${snapshot.url}`, `- title: ${snapshot.title}`]
  for (const node of snapshot.dom ?? []) {
    const role = node.role ?? node.tag
    const label = node.name ? ` "${node.name}"` : ''
    const text = node.text ? `: ${node.text}` : ''
    lines.push(`${'  '.repeat(Math.min(node.depth, 8))}- ${role}${label}${text}`)
  }
  return lines.join('\n')
}

/**
 * The page-probing tail of the dispatcher: elementInfo reads the cached ref
 * table by coordinates, evaluate runs JS through browserEval, waitFor parks
 * on a selector or text, and the playwright action subset the skill workflow
 * leans on (load-state/URL waits, domSnapshot, evaluate) is answered for real.
 */
export abstract class ZcodeBrowserProbeCommands extends ZcodeBrowserPointerCommands {
  async elementInfo(tab: ZcodeBrowserTab, command: Record<string, unknown>, startedAt: number) {
    if (!tab.snapshot) {
      return zcodeBrowserUnsupported('elementInfo (no snapshot)', startedAt)
    }
    const x = zcodeBrowserNumberOr(command.x, Number.NaN)
    const y = zcodeBrowserNumberOr(command.y, Number.NaN)
    const hit = tab.snapshot.elements.find(
      (element) =>
        x >= element.rect.x &&
        x <= element.rect.x + element.rect.width &&
        y >= element.rect.y &&
        y <= element.rect.y + element.rect.height
    )
    return { ok: true, ...(hit ? { element: hit } : {}), elapsedMs: Date.now() - startedAt }
  }

  async evaluate(tab: ZcodeBrowserTab, command: Record<string, unknown>, startedAt: number) {
    const expression = typeof command.expression === 'string' ? command.expression : ''
    if (!expression) {
      return zcodeBrowserMissingTarget('evaluate', startedAt)
    }
    const evaluated = await this.surfaceEval(expression, tab.browserPageId)
    let value: unknown = evaluated.result
    try {
      value = JSON.parse(evaluated.result)
    } catch {
      // Non-JSON scalar: the string is the value.
    }
    return { ok: true, value, elapsedMs: Date.now() - startedAt }
  }

  async waitFor(tab: ZcodeBrowserTab, command: Record<string, unknown>, startedAt: number) {
    if (command.textGone !== undefined) {
      return zcodeBrowserUnsupported('waitFor(textGone)', startedAt)
    }
    const selector = typeof command.selector === 'string' ? command.selector : undefined
    const text = typeof command.text === 'string' ? command.text : undefined
    if (!selector && !text) {
      return zcodeBrowserMissingTarget('waitFor', startedAt)
    }
    await this.writeSurface().browserWait({
      ...(selector ? { selector } : {}),
      ...(text ? { text } : {}),
      page: tab.browserPageId
    })
    return { ok: true, elapsedMs: Date.now() - startedAt }
  }

  /** The playwright actions this backend really answers, shaped like the CLI's. */
  async playwrightAction(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    void sessionId
    const action = (command.action ?? {}) as Record<string, unknown>
    const name = typeof action.name === 'string' ? action.name : ''
    const timeoutMs = Math.min(
      Math.max(1, zcodeBrowserNumberOr(action.timeoutMs, PLAYWRIGHT_DEFAULT_TIMEOUT_MS)),
      PLAYWRIGHT_MAX_TIMEOUT_MS
    )
    if (name === 'waitForLoadState') {
      const state = typeof action.state === 'string' ? action.state : 'load'
      if (state === 'networkidle') {
        return zcodeBrowserErrorResult(
          {
            code: 'capability_unsupported',
            message: 'playwright waitForLoadState does not support networkidle'
          },
          startedAt
        )
      }
      await this.pollPage(timeoutMs, () =>
        this.readReadyState(tab, state === 'load' ? 'complete' : ['interactive', 'complete'])
      )
      return { ok: true, elapsedMs: Date.now() - startedAt }
    }
    if (name === 'waitForURL') {
      const wanted = typeof action.url === 'string' ? action.url : ''
      if (!wanted) {
        return zcodeBrowserMissingTarget('playwright.waitForURL', startedAt)
      }
      if (action.waitUntil === 'networkidle') {
        return zcodeBrowserErrorResult(
          {
            code: 'capability_unsupported',
            message: 'playwright waitForURL does not support networkidle'
          },
          startedAt
        )
      }
      await this.pollPage(timeoutMs, async () => {
        const read = await this.surfaceEval('location.href', tab.browserPageId)
        const href = JSON.parse(read.result) as string
        return typeof href === 'string' && urlMatches(href, wanted)
      })
      return { ok: true, elapsedMs: Date.now() - startedAt }
    }
    if (name === 'domSnapshot') {
      const snapshot = await this.collect(tab, {})
      return { ok: true, value: ariaStyleSnapshot(snapshot), elapsedMs: Date.now() - startedAt }
    }
    if (name === 'evaluate') {
      // Function-kind expressions are a page function to CALL with arg, not a
      // statement to run — evaluating them bare returns undefined (the agent
      // sees silent empty results). Same wrapping as the CLI reference.
      const expression = typeof action.expression === 'string' ? action.expression : ''
      const source =
        action.expressionKind === 'function' && expression
          ? `(${expression})(${JSON.stringify(action.arg ?? null)})`
          : expression
      return this.evaluate(tab, { expression: source }, startedAt)
    }
    return zcodeBrowserUnsupported(`playwright(${name})`, startedAt)
  }

  /** playwrightWaitForTimeout: a bounded sleep, 0 still yields one tick. */
  async playwrightWaitForTimeout(command: Record<string, unknown>, startedAt: number) {
    const timeoutMs = Math.min(
      Math.max(0, zcodeBrowserNumberOr(command.timeoutMs, 0)),
      PLAYWRIGHT_MAX_TIMEOUT_MS
    )
    await new Promise((resolve) => setTimeout(resolve, timeoutMs))
    return { ok: true, elapsedMs: Date.now() - startedAt }
  }

  private async readReadyState(tab: ZcodeBrowserTab, accept: string | string[]): Promise<boolean> {
    const read = await this.surfaceEval('document.readyState', tab.browserPageId)
    const state = JSON.parse(read.result) as string
    return (
      typeof state === 'string' &&
      (Array.isArray(accept) ? accept.includes(state) : state === accept)
    )
  }

  private async pollPage(timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await probe()) {
        return
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`Timed out after ${timeoutMs}ms waiting for the page`), {
          code: 'browser_timeout'
        })
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }
}
