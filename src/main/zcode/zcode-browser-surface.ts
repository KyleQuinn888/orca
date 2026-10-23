import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'

/**
 * The browser command surface a host lends the zcode bridge. Type-only import:
 * constructing RuntimeBrowserCommands drags in the Chromium cluster, so the
 * desktop host hands over its already-built instance and a Node host lends
 * nothing — every browser request then answers `backend_unavailable`.
 */
export type ZcodeBrowserCommandSurface = Pick<
  RuntimeBrowserCommands,
  | 'browserTabCreate'
  | 'browserTabClose'
  | 'browserTabList'
  | 'browserTabShow'
  | 'browserGoto'
  | 'browserBack'
  | 'browserForward'
  | 'browserReload'
  | 'browserEval'
  | 'browserScreenshot'
  | 'browserFullScreenshot'
  | 'browserClick'
  | 'browserDblclick'
  | 'browserFill'
  | 'browserType'
  | 'browserFocus'
  | 'browserKeypress'
  | 'browserSelect'
  | 'browserCheck'
  | 'browserHover'
  | 'browserScrollIntoView'
  | 'browserDrag'
  | 'browserWait'
  | 'browserMouseClick'
  | 'browserMouseWheel'
  | 'browserMouseMove'
  | 'browserMouseDown'
  | 'browserMouseUp'
>

/** Resolves lazily so a runtime assembled before its browser engine still boots. */
export type ZcodeBrowserSurfaceProvider = () => ZcodeBrowserCommandSurface | null

export function zcodeBrowserSurfaceAvailable(provider: ZcodeBrowserSurfaceProvider): boolean {
  try {
    return provider() !== null
  } catch {
    return false
  }
}
