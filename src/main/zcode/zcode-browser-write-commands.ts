import type { ZcodeBrowserTab } from './zcode-browser-session'
import type { ZcodeSnapshotElement } from './zcode-browser-snapshot'
import type { ZcodeBrowserCommandSurface } from './zcode-browser-surface'
import { ZcodeBrowserReadCommands } from './zcode-browser-read-commands'
import { zcodeBrowserMissingTarget, zcodeBrowserRefNotFound } from './zcode-browser-results'

export type ZcodeBrowserModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'

/** zcode key modifiers → the surface's pointer modifier vocabulary. */
function pointerModifiers(
  modifiers: ZcodeBrowserModifier[] | undefined
): ('cmd' | 'ctrl' | 'alt' | 'shift')[] | undefined {
  if (modifiers === undefined) {
    return undefined
  }
  return modifiers.map((modifier) =>
    modifier === 'Shift'
      ? 'shift'
      : modifier === 'Alt'
        ? 'alt'
        : modifier === 'Meta'
          ? 'cmd'
          : 'ctrl'
  )
}

/** Key combos travel as one string; ControlOrMeta collapses per platform. */
function keyCombo(keys: string[]): string {
  const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
  return keys.map((key) => (key === 'ControlOrMeta' ? primary : key)).join('+')
}

/**
 * The selector-action half of the dispatcher: commands resolve their ref
 * against the tab's cached snapshot (the ref table), then address the Orca
 * surface by the element's CSS selector.
 */
export abstract class ZcodeBrowserWriteCommands extends ZcodeBrowserReadCommands {
  protected abstract writeSurface(): ZcodeBrowserCommandSurface

  protected abstract resolveRef(tab: ZcodeBrowserTab, ref: string): ZcodeSnapshotElement | null

  /**
   * agent-browser clicks/fills at the element's viewport coordinates without
   * scrolling it into view first; below the fold the input lands outside the
   * view surface and is silently ignored (verified against 0.27.0). Every
   * positional selector action scrolls first.
   */
  private async intoView(
    surface: ZcodeBrowserCommandSurface,
    selector: string,
    page: string
  ): Promise<void> {
    await surface.browserScrollIntoView({ element: selector, page })
  }

  async click(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const surface = this.writeSurface()
    const modifiers = readModifiers(command.modifiers)
    const button = typeof command.button === 'string' ? command.button : undefined
    if (command.ref !== undefined) {
      const element = this.resolveRef(tab, String(command.ref))
      if (!element) {
        return zcodeBrowserRefNotFound(command.ref, startedAt)
      }
      // Why not agent-browser's selector click: its daemon retires after an
      // idle window and a cold restart binds to a stale page view — the click
      // then no-ops (verified live). In-page geometry + the bridge's DOM
      // activation path stay correct across daemon restarts. Double clicks
      // keep the daemon path: the bridge's synthetic mouse has no clickCount.
      if (command.doubleClick === true) {
        await this.intoView(surface, element.selector, tab.browserPageId)
        await surface.browserDblclick({ element: element.selector, page: tab.browserPageId })
        return this.writeOkMeta(sessionId, tab, startedAt)
      }
      const center = await this.elementCenter(element.selector, tab.browserPageId)
      if (!center) {
        return zcodeBrowserRefNotFound(command.ref, startedAt)
      }
      await surface.browserMouseClick({
        x: center.x,
        y: center.y,
        radius: 24,
        ...(button ? { button } : {}),
        ...(modifiers ? { modifiers: pointerModifiers(modifiers) } : {}),
        page: tab.browserPageId
      })
      return this.writeOkMeta(sessionId, tab, startedAt)
    }
    const point = readPoint(command)
    if (!point) {
      return zcodeBrowserMissingTarget('click', startedAt)
    }
    await surface.browserMouseClick({
      x: point.x,
      y: point.y,
      // A radius routes the click through the bridge's in-page DOM activation,
      // which resolves the point in page space — immune to pane zoom/DPR.
      radius: 24,
      ...(button ? { button } : {}),
      ...(modifiers ? { modifiers: pointerModifiers(modifiers) } : {}),
      page: tab.browserPageId
    })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  /** Scroll the element into view and read its center, all in page space. */
  private async elementCenter(
    selector: string,
    page: string
  ): Promise<{ x: number; y: number } | null> {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) { return null }
      if (el.scrollIntoViewIfNeeded) { el.scrollIntoViewIfNeeded() }
      else if (el.scrollIntoView) { el.scrollIntoView({ block: 'center' }) }
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`
    const read = await this.surfaceEval(expression, page)
    if (!read.result || read.result === 'null') {
      return null
    }
    try {
      const parsed = JSON.parse(read.result) as { x?: unknown; y?: unknown }
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return { x: parsed.x, y: parsed.y }
      }
    } catch {
      // Unreadable geometry reads as a miss.
    }
    return null
  }

  async fill(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const element = this.resolveRef(tab, String(command.ref ?? ''))
    if (!element) {
      return zcodeBrowserRefNotFound(command.ref, startedAt)
    }
    const surface = this.writeSurface()
    await this.intoView(surface, element.selector, tab.browserPageId)
    await surface.browserFill({
      element: element.selector,
      value: typeof command.value === 'string' ? command.value : '',
      page: tab.browserPageId
    })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async type(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const surface = this.writeSurface()
    if (command.ref !== undefined) {
      const element = this.resolveRef(tab, String(command.ref))
      if (!element) {
        return zcodeBrowserRefNotFound(command.ref, startedAt)
      }
      await this.intoView(surface, element.selector, tab.browserPageId)
      await surface.browserFocus({ element: element.selector, page: tab.browserPageId })
    }
    await surface.browserType({
      input: typeof command.text === 'string' ? command.text : '',
      page: tab.browserPageId
    })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async press(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const key = typeof command.key === 'string' ? command.key : ''
    if (!key) {
      return zcodeBrowserMissingTarget('press', startedAt)
    }
    const surface = this.writeSurface()
    if (command.ref !== undefined) {
      const element = this.resolveRef(tab, String(command.ref))
      if (!element) {
        return zcodeBrowserRefNotFound(command.ref, startedAt)
      }
      await this.intoView(surface, element.selector, tab.browserPageId)
      await surface.browserFocus({ element: element.selector, page: tab.browserPageId })
    }
    const combo = keyCombo([...(readModifiers(command.modifiers) ?? []), key])
    await surface.browserKeypress({ key: combo, page: tab.browserPageId })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async cuaKeypress(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const keys = Array.isArray(command.keys)
      ? command.keys.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (keys.length === 0) {
      return zcodeBrowserMissingTarget('cuaKeypress', startedAt)
    }
    await this.writeSurface().browserKeypress({ key: keyCombo(keys), page: tab.browserPageId })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async select(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const element = this.resolveRef(tab, String(command.ref ?? ''))
    if (!element) {
      return zcodeBrowserRefNotFound(command.ref, startedAt)
    }
    const values = Array.isArray(command.values)
      ? command.values.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (values.length === 0) {
      return zcodeBrowserMissingTarget('select', startedAt)
    }
    // One value goes through the surface's select; several need an accumulation
    // semantics the surface does not offer, so they set options in-page and
    // dispatch the change events a real interaction fires.
    const surface = this.writeSurface()
    await this.intoView(surface, element.selector, tab.browserPageId)
    if (values.length === 1) {
      await surface.browserSelect({
        element: element.selector,
        value: values[0],
        page: tab.browserPageId
      })
      return this.writeOkMeta(sessionId, tab, startedAt)
    }
    await this.markSelectOptions(element.selector, values, tab.browserPageId)
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async check(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const element = this.resolveRef(tab, String(command.ref ?? ''))
    if (!element) {
      return zcodeBrowserRefNotFound(command.ref, startedAt)
    }
    const surface = this.writeSurface()
    await this.intoView(surface, element.selector, tab.browserPageId)
    await surface.browserCheck({
      element: element.selector,
      checked: command.checked !== false,
      page: tab.browserPageId
    })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async hover(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    if (command.ref !== undefined) {
      const element = this.resolveRef(tab, String(command.ref))
      if (!element) {
        return zcodeBrowserRefNotFound(command.ref, startedAt)
      }
      const surface = this.writeSurface()
      await this.intoView(surface, element.selector, tab.browserPageId)
      await surface.browserHover({ element: element.selector, page: tab.browserPageId })
      return this.writeOkMeta(sessionId, tab, startedAt)
    }
    const point = readPoint(command)
    if (!point) {
      return zcodeBrowserMissingTarget('hover', startedAt)
    }
    await this.writeSurface().browserMouseMove({ ...point, page: tab.browserPageId })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async drag(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const from = this.resolveRef(tab, String(command.fromRef ?? ''))
    const to = this.resolveRef(tab, String(command.toRef ?? ''))
    if (!from || !to) {
      return zcodeBrowserRefNotFound(command.fromRef ?? command.toRef, startedAt)
    }
    const surface = this.writeSurface()
    await this.intoView(surface, from.selector, tab.browserPageId)
    await this.intoView(surface, to.selector, tab.browserPageId)
    await surface.browserDrag({
      from: from.selector,
      to: to.selector,
      page: tab.browserPageId
    })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  protected writeOkMeta(sessionId: string, tab: ZcodeBrowserTab, startedAt: number) {
    return {
      ok: true as const,
      meta: this.metaFor(sessionId, tab),
      elapsedMs: Date.now() - startedAt
    }
  }
}

function readModifiers(value: unknown): ZcodeBrowserModifier[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.filter((entry): entry is ZcodeBrowserModifier =>
    ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'].includes(String(entry))
  )
}

function readPoint(command: Record<string, unknown>): { x: number; y: number } | null {
  if (typeof command.x !== 'number' || typeof command.y !== 'number') {
    return null
  }
  return { x: command.x, y: command.y }
}
