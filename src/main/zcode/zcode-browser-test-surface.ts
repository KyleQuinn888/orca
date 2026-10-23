import { vi } from 'vitest'

import { ZcodeBrowserBackend } from './zcode-browser-backend'
import type { ZcodeBrowserCommandSurface } from './zcode-browser-surface'
import type { ZcodeSnapshot } from './zcode-browser-snapshot'

/** Shared fakes for the zcode browser command tests. */
export { SAMPLE_SNAPSHOT, sampleEvalResult, fakeSurface, surfaceCalls, snappedBackend }

export type { SurfaceCalls }

const SAMPLE_SNAPSHOT: ZcodeSnapshot = {
  url: 'https://example.org/page',
  title: 'Example',
  elements: [
    {
      ref: 'e1',
      tag: 'a',
      role: 'link',
      name: 'More',
      selector: 'body > a:nth-of-type(1)',
      xpath: '/html/body/a[1]',
      rect: { x: 8, y: 20, width: 40, height: 16 },
      inViewport: true
    },
    {
      ref: 'e2',
      tag: 'input',
      role: 'textbox',
      name: 'Search',
      selector: 'body > input:nth-of-type(1)',
      xpath: '/html/body/input[1]',
      rect: { x: 8, y: 60, width: 200, height: 24 },
      inViewport: true
    }
  ],
  truncated: false,
  dom: [
    { tag: 'body', depth: 0, inViewport: true },
    {
      tag: 'p',
      depth: 1,
      inViewport: true,
      text: 'This domain is for use in illustrative examples.'
    },
    {
      tag: 'a',
      depth: 2,
      inViewport: true,
      role: 'link',
      name: 'More',
      text: 'More information...'
    }
  ],
  scrollX: 0,
  scrollY: 12,
  viewportWidth: 1280,
  viewportHeight: 720
}

function sampleEvalResult(): string {
  return JSON.stringify(SAMPLE_SNAPSHOT)
}

type SurfaceCalls = {
  created: { url: string }[]
  closed: string[]
  gotos: { url: string; page: string }[]
  evals: string[]
  clicked: string[]
  filled: { element: string; value: string }[]
  typed: string[]
  focused: string[]
  pressed: string[]
  selected: { element: string; value: string }[]
  checked: { element: string; checked: boolean }[]
  hovered: string[]
  dragged: { from: string; to: string }[]
  mouse: string[]
  waited: unknown[]
  scrolledIntoView: string[]
}

function fakeSurface(
  calls: SurfaceCalls,
  overrides: Partial<Record<keyof ZcodeBrowserCommandSurface, () => never>> = {}
): ZcodeBrowserCommandSurface {
  let nextPage = 0
  return {
    browserTabCreate:
      overrides.browserTabCreate ??
      vi.fn(async (params: { url?: string }) => {
        const page = `page-${(nextPage += 1)}`
        calls.created.push({ url: params.url ?? 'about:blank' })
        return { browserPageId: page }
      }),
    browserTabClose:
      overrides.browserTabClose ??
      vi.fn(async (params: { page?: string }) => {
        calls.closed.push(params.page ?? '')
        return { closed: true }
      }),
    browserTabList: overrides.browserTabList ?? vi.fn(async () => ({ tabs: [] })),
    browserTabShow: overrides.browserTabShow ?? vi.fn(async () => ({ tab: {} as never })),
    browserGoto:
      overrides.browserGoto ??
      vi.fn(async (params: { url: string; page?: string }) => {
        calls.gotos.push({ url: params.url, page: params.page ?? '' })
        return { url: params.url, title: 'Example' }
      }),
    browserBack:
      overrides.browserBack ??
      vi.fn(async () => ({ url: 'https://example.org/', title: 'Example' })),
    browserForward:
      overrides.browserForward ??
      vi.fn(async () => ({ url: 'https://example.org/page', title: 'Example' })),
    browserReload:
      overrides.browserReload ??
      vi.fn(async () => ({ url: 'https://example.org/page', title: 'Example' })),
    browserEval:
      overrides.browserEval ??
      vi.fn(async (params: { expression: string }) => {
        calls.evals.push(params.expression)
        // Expression-aware answers: scalar probes read as JSON strings, the
        // collector expression gets the sample snapshot object.
        const result = params.expression.includes('querySelectorAll')
          ? sampleEvalResult()
          : params.expression.includes('document.readyState')
            ? '"complete"'
            : params.expression.includes('location.href')
              ? '"https://example.org/page"'
              : sampleEvalResult()
        return { result, origin: 'https://example.org' }
      }),
    browserScreenshot:
      overrides.browserScreenshot ?? vi.fn(async () => ({ data: 'aGk=', format: 'png' as const })),
    browserFullScreenshot:
      overrides.browserFullScreenshot ??
      vi.fn(async () => ({ data: 'aGk=', format: 'png' as const })),
    browserClick:
      overrides.browserClick ??
      vi.fn(async (params: { element: string }) => {
        calls.clicked.push(params.element)
        return { clicked: params.element }
      }),
    browserDblclick:
      overrides.browserDblclick ??
      vi.fn(async (params: { element: string }) => {
        calls.clicked.push(`dbl:${params.element}`)
        return { clicked: params.element }
      }),
    browserFill:
      overrides.browserFill ??
      vi.fn(async (params: { element: string; value: string }) => {
        calls.filled.push({ element: params.element, value: params.value })
        return { filled: params.element }
      }),
    browserType:
      overrides.browserType ??
      vi.fn(async (params: { input: string }) => {
        calls.typed.push(params.input)
        return { typed: true }
      }),
    browserFocus:
      overrides.browserFocus ??
      vi.fn(async (params: { element: string }) => {
        calls.focused.push(params.element)
        return { focused: params.element }
      }),
    browserKeypress:
      overrides.browserKeypress ??
      vi.fn(async (params: { key: string }) => {
        calls.pressed.push(params.key)
        return { pressed: params.key }
      }),
    browserSelect:
      overrides.browserSelect ??
      vi.fn(async (params: { element: string; value: string }) => {
        calls.selected.push({ element: params.element, value: params.value })
        return { selected: params.value }
      }),
    browserCheck:
      overrides.browserCheck ??
      vi.fn(async (params: { element: string; checked: boolean }) => {
        calls.checked.push({ element: params.element, checked: params.checked })
        return { checked: params.element }
      }),
    browserHover:
      overrides.browserHover ??
      vi.fn(async (params: { element: string }) => {
        calls.hovered.push(params.element)
        return { hovered: params.element }
      }),
    browserScrollIntoView:
      overrides.browserScrollIntoView ??
      vi.fn(async (params: { element: string }) => {
        calls.scrolledIntoView.push(params.element)
        return {}
      }),
    browserDrag:
      overrides.browserDrag ??
      vi.fn(async (params: { from: string; to: string }) => {
        calls.dragged.push({ from: params.from, to: params.to })
        return {} as never
      }),
    browserWait:
      overrides.browserWait ??
      vi.fn(async (params: unknown) => {
        calls.waited.push(params)
        return {} as never
      }),
    browserMouseClick:
      overrides.browserMouseClick ??
      vi.fn(async (params: { x: number; y: number }) => {
        calls.mouse.push(`click@${params.x},${params.y}`)
        return {}
      }),
    browserMouseWheel:
      overrides.browserMouseWheel ??
      vi.fn(async (params: { dy: number; dx?: number }) => {
        calls.mouse.push(`wheel dy=${params.dy}`)
        return {}
      }),
    browserMouseMove:
      overrides.browserMouseMove ??
      vi.fn(async (params: { x: number; y: number }) => {
        calls.mouse.push(`move@${params.x},${params.y}`)
        return {}
      }),
    browserMouseDown:
      overrides.browserMouseDown ?? vi.fn(async () => (calls.mouse.push('down'), {})),
    browserMouseUp: overrides.browserMouseUp ?? vi.fn(async () => (calls.mouse.push('up'), {}))
  } as unknown as ZcodeBrowserCommandSurface
}

/** A calls record pre-filled with every list the suites append to. */
function surfaceCalls(): SurfaceCalls {
  return {
    created: [],
    closed: [],
    gotos: [],
    evals: [],
    clicked: [],
    filled: [],
    typed: [],
    focused: [],
    pressed: [],
    selected: [],
    checked: [],
    hovered: [],
    dragged: [],
    mouse: [],
    waited: [],
    scrolledIntoView: []
  }
}

/** A backend whose default tab already holds a fresh sample snapshot. */
async function snappedBackend(calls: SurfaceCalls) {
  const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
  await backend.execute({
    sessionId: 'sess_1',
    browserId: backend.browserId,
    command: { method: 'navigate', url: 'https://example.org' }
  })
  return backend
}
