import type { ZcodeBrowserTab } from './zcode-browser-session'
import { ZcodeBrowserWriteCommands } from './zcode-browser-write-commands'
import {
  zcodeBrowserMissingTarget,
  zcodeBrowserNumberOr,
  zcodeBrowserRefNotFound,
  type ZcodeBrowserCommandResult
} from './zcode-browser-results'

/**
 * The coordinate half of the dispatcher: scroll and drag families that speak
 * viewport geometry (cua), plus domCuaScroll which anchors the wheel on a ref.
 */
export abstract class ZcodeBrowserPointerCommands extends ZcodeBrowserWriteCommands {
  async scroll(
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
      await this.writeSurface().browserScrollIntoView({
        element: element.selector,
        page: tab.browserPageId
      })
    }
    await this.surfaceEval(
      `window.scrollBy(${zcodeBrowserNumberOr(command.x, 0)}, ${zcodeBrowserNumberOr(command.y, 0)})`,
      tab.browserPageId
    )
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async cuaScroll(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    await this.writeSurface().browserMouseMove({
      x: zcodeBrowserNumberOr(command.x, 0),
      y: zcodeBrowserNumberOr(command.y, 0),
      page: tab.browserPageId
    })
    await this.writeSurface().browserMouseWheel({
      dy: zcodeBrowserNumberOr(command.scrollY, 0),
      dx: zcodeBrowserNumberOr(command.scrollX, 0),
      page: tab.browserPageId
    })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  /** domCuaScroll anchors the wheel at a ref's center, else the viewport's. */
  async domCuaScroll(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ): Promise<ZcodeBrowserCommandResult> {
    let anchor: { x: number; y: number }
    if (typeof command.nodeId === 'string') {
      const element = this.resolveRef(tab, command.nodeId)
      if (!element) {
        return zcodeBrowserRefNotFound(command.nodeId, startedAt)
      }
      anchor = {
        x: element.rect.x + element.rect.width / 2,
        y: element.rect.y + element.rect.height / 2
      }
    } else {
      anchor = {
        x: (tab.snapshot?.viewportWidth ?? 1280) / 2,
        y: (tab.snapshot?.viewportHeight ?? 720) / 2
      }
    }
    const scrollX = zcodeBrowserNumberOr(command.scrollX, 0)
    const scrollY = zcodeBrowserNumberOr(command.scrollY, 0)
    await this.writeSurface().browserMouseMove({ ...anchor, page: tab.browserPageId })
    await this.writeSurface().browserMouseWheel({
      dy: scrollY,
      dx: scrollX,
      page: tab.browserPageId
    })
    return this.writeOkMeta(sessionId, tab, startedAt)
  }

  async cuaDrag(
    sessionId: string,
    tab: ZcodeBrowserTab,
    command: Record<string, unknown>,
    startedAt: number
  ) {
    const points = (Array.isArray(command.path) ? command.path : []).filter(
      (point): point is { x: number; y: number } =>
        typeof point === 'object' &&
        point !== null &&
        typeof (point as { x?: unknown }).x === 'number' &&
        typeof (point as { y?: unknown }).y === 'number'
    )
    if (points.length === 0) {
      return zcodeBrowserMissingTarget('cuaDrag', startedAt)
    }
    const surface = this.writeSurface()
    // The path is the contract: every point is sent, not just the endpoints.
    await surface.browserMouseMove({ ...points[0], page: tab.browserPageId })
    await surface.browserMouseDown({ page: tab.browserPageId })
    try {
      for (const point of points.slice(1)) {
        await surface.browserMouseMove({ ...point, page: tab.browserPageId })
      }
    } finally {
      await surface.browserMouseUp({ page: tab.browserPageId })
    }
    return this.writeOkMeta(sessionId, tab, startedAt)
  }
}
