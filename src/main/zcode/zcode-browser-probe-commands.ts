import type { ZcodeBrowserTab } from './zcode-browser-session'
import { ZcodeBrowserPointerCommands } from './zcode-browser-pointer-commands'
import {
  zcodeBrowserMissingTarget,
  zcodeBrowserNumberOr,
  zcodeBrowserUnsupported
} from './zcode-browser-results'

/**
 * The page-probing tail of the dispatcher: elementInfo reads the cached
 * ref table by coordinates, evaluate runs JS through browserEval, waitFor
 * parks on a selector or text.
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
}
