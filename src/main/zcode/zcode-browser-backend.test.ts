import { describe, expect, it, vi } from 'vitest'

import { ZcodeBrowserBackend, answerZcodeBrowserWireRequest } from './zcode-browser-backend'
import type { ZcodeBrowserCommandSurface } from './zcode-browser-surface'
import type { ZcodeSnapshot } from './zcode-browser-snapshot'

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
        return { result: sampleEvalResult(), origin: 'https://example.org' }
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

describe('ZcodeBrowserBackend.list', () => {
  it('offers the Orca backend when the host lends a surface', () => {
    const backend = new ZcodeBrowserBackend(() => fakeSurface(surfaceCalls()))
    const { browsers } = backend.list()
    expect(browsers).toHaveLength(1)
    expect(browsers[0]).toMatchObject({
      id: 'orca:embedded-browser',
      generation: 0,
      type: 'cdp',
      name: 'Orca Browser'
    })
    expect(browsers[0].apiSupportOverrides?.['BrowserUser.openTabs']).toBe(false)
  })

  it('reads an honest empty list without a surface', () => {
    const backend = new ZcodeBrowserBackend(() => null)
    expect(backend.list()).toEqual({ browsers: [] })
  })
})

describe('ZcodeBrowserBackend.execute', () => {
  it('answers backend_unavailable without a surface', async () => {
    const backend = new ZcodeBrowserBackend(() => null)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: 'orca:embedded-browser',
      command: { method: 'list' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('backend_unavailable')
  })

  it('rejects envelopes addressed to another backend', async () => {
    const backend = new ZcodeBrowserBackend(() => fakeSurface(surfaceCalls()))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: 'cdp:someone-else',
      command: { method: 'list' }
    })
    expect(result.error?.code).toBe('backend_unavailable')
  })

  it('newTab registers an Orca page as a zcode tab', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      browserGeneration: 0,
      command: { method: 'newTab' }
    })
    expect(result.ok).toBe(true)
    expect(calls.created).toEqual([{ url: 'about:blank' }])
    expect(result.tab).toMatchObject({
      url: 'about:blank',
      viewport: { width: 1280, height: 720 },
      active: true
    })
    expect(result.meta?.openTabIds).toHaveLength(1)
  })

  it('navigate without a tab creates the default page and returns state', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'navigate', url: 'https://example.org' }
    })
    expect(result.ok).toBe(true)
    expect(calls.created).toEqual([{ url: 'https://example.org' }])
    expect(result.state).toMatchObject({
      url: 'https://example.org/page',
      title: 'Example',
      canGoBack: true,
      scrollY: 12,
      viewportWidth: 1280
    })
  })

  it('blocks non-http navigation URLs', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'navigate', url: 'file:///etc/passwd' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('navigation_blocked')
    expect(calls.created).toHaveLength(0)
  })

  it('snapshot returns wire-shaped snapshot without collector extras', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'navigate', url: 'https://example.org' }
    })
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'snapshot' }
    })
    expect(result.ok).toBe(true)
    expect(result.snapshot?.elements[0]).toMatchObject({ ref: 'e1', role: 'link' })
    expect(result.snapshot).not.toHaveProperty('scrollX')
    expect(result.snapshot).not.toHaveProperty('viewportWidth')
    expect(calls.evals[0]).toContain('querySelectorAll')
  })

  it('snapshot honors maxElements in the collector expression', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'newTab' }
    })
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'snapshot', maxElements: 25 }
    })
    expect(calls.evals[0]).toContain('"maxElements":25')
  })

  it('list reports the session tabs after a newTab', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'newTab' }
    })
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'list' }
    })
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs?.[0]).toMatchObject({ url: 'about:blank', active: true })
  })

  it('close drops the tab and closes the Orca page', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    const created = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'newTab' }
    })
    const tabId = created.tab?.tabId ?? ''
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'close', tabId }
    })
    expect(result.ok).toBe(true)
    expect(calls.closed).toEqual(['page-1'])
    const after = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'list' }
    })
    expect(after.tabs).toHaveLength(0)
  })

  it('unknown commands answer capability_unsupported, not a throw', async () => {
    const backend = new ZcodeBrowserBackend(() => fakeSurface(surfaceCalls()))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'recordingStart' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('capability_unsupported')
  })

  it('maps surface timeout errors to the zcode timeout code', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const surface = fakeSurface(calls, {
      browserGoto: vi.fn(async () => {
        throw Object.assign(new Error('Timed out'), { code: 'browser_timeout' })
      }) as never
    })
    const backend = new ZcodeBrowserBackend(() => surface)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'newTab' }
    })
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'navigate', url: 'https://example.org' }
    })
    expect(result.error?.code).toBe('timeout')
  })
})

describe('ZcodeBrowserBackend.releaseSession', () => {
  it('closes the pages a session opened and forgets its tabs', async () => {
    const calls: SurfaceCalls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'newTab' }
    })
    await backend.releaseSession('sess_1')
    expect(calls.closed).toEqual(['page-1'])
    const after = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'list' }
    })
    expect(after.tabs).toHaveLength(0)
  })
})

describe('answerZcodeBrowserWireRequest', () => {
  function wire() {
    const responded: { id: unknown; result: unknown }[] = []
    const errors: { id: unknown; code: number }[] = []
    return {
      responded,
      errors,
      connection: {
        respond: (id: unknown, result: unknown) => responded.push({ id, result }),
        respondWithError: (id: unknown, code: number) => errors.push({ id, code })
      }
    }
  }

  it('answers discovery with the backend list', () => {
    const backend = new ZcodeBrowserBackend(() => fakeSurface(surfaceCalls()))
    const harness = wire()
    answerZcodeBrowserWireRequest(
      backend,
      { id: 7, method: 'interaction/browserList', params: {} },
      harness.connection
    )
    expect(harness.responded).toHaveLength(1)
    expect(harness.responded[0].result).toMatchObject({
      browsers: [{ id: 'orca:embedded-browser' }]
    })
  })

  it('answers discovery empty without a backend', () => {
    const harness = wire()
    answerZcodeBrowserWireRequest(
      undefined,
      { id: 8, method: 'interaction/browserList', params: {} },
      harness.connection
    )
    expect(harness.responded[0].result).toEqual({ browsers: [] })
  })

  it('replies asynchronously once the command settles', async () => {
    const backend = new ZcodeBrowserBackend(() => fakeSurface(surfaceCalls()))
    const harness = wire()
    answerZcodeBrowserWireRequest(
      backend,
      {
        id: 9,
        method: 'interaction/browserExecute',
        params: { sessionId: 'sess_1', browserId: backend.browserId, command: { method: 'list' } }
      },
      harness.connection
    )
    expect(harness.responded).toHaveLength(0)
    await vi.waitFor(() => expect(harness.responded).toHaveLength(1))
  })

  it('errors with -32001 when no backend exists', () => {
    const harness = wire()
    answerZcodeBrowserWireRequest(
      undefined,
      { id: 10, method: 'interaction/browserExecute', params: {} },
      harness.connection
    )
    expect(harness.errors[0]).toEqual({ id: 10, code: -32001 })
  })
})

describe('ZcodeBrowserBackend.execute write commands', () => {
  it('click by ref forwards the snapshot selector', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e1' }
    })
    expect(result.ok).toBe(true)
    expect(calls.clicked).toEqual(['body > a:nth-of-type(1)'])
  })

  it('click by coordinates goes through the mouse path', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', x: 100, y: 200, doubleClick: true }
    })
    expect(result.ok).toBe(true)
    expect(calls.mouse).toEqual(['click@100,200'])
  })

  it('click with an unknown ref answers ref_not_found', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e99' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ref_not_found')
    expect(calls.clicked).toHaveLength(0)
  })

  it('fill sends the ref selector and value', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'fill', ref: 'e2', value: 'orca' }
    })
    expect(result.ok).toBe(true)
    expect(calls.filled).toEqual([{ element: 'body > input:nth-of-type(1)', value: 'orca' }])
  })

  it('type with a ref focuses it first, then types the text', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'type', ref: 'e2', text: 'hello' }
    })
    expect(result.ok).toBe(true)
    expect(calls.focused).toEqual(['body > input:nth-of-type(1)'])
    expect(calls.typed).toEqual(['hello'])
  })

  it('press folds modifiers into one combo string', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'press', key: 'Enter', modifiers: ['ControlOrMeta', 'Shift'] }
    })
    expect(result.ok).toBe(true)
    const expectedPrimary = process.platform === 'darwin' ? 'Meta' : 'Control'
    expect(calls.pressed).toEqual([`${expectedPrimary}+Shift+Enter`])
  })

  it('select forwards the first value to the surface', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'select', ref: 'e2', values: ['a', 'b'] }
    })
    expect(result.ok).toBe(true)
    expect(calls.selected).toEqual([{ element: 'body > input:nth-of-type(1)', value: 'a' }])
  })

  it('check forwards the explicit unchecked state', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'check', ref: 'e2', checked: false }
    })
    expect(result.ok).toBe(true)
    expect(calls.checked).toEqual([{ element: 'body > input:nth-of-type(1)', checked: false }])
  })

  it('drag resolves both refs to selectors', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'drag', fromRef: 'e1', toRef: 'e2' }
    })
    expect(result.ok).toBe(true)
    expect(calls.dragged).toEqual([
      { from: 'body > a:nth-of-type(1)', to: 'body > input:nth-of-type(1)' }
    ])
  })

  it('cuaDrag sends every path point as a mouse sequence', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: {
        method: 'cuaDrag',
        path: [
          { x: 0, y: 0 },
          { x: 10, y: 5 },
          { x: 20, y: 10 }
        ]
      }
    })
    expect(result.ok).toBe(true)
    expect(calls.mouse).toEqual(['move@0,0', 'down', 'move@10,5', 'move@20,10', 'up'])
  })

  it('scroll evaluates window.scrollBy with the deltas', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'scroll', x: 0, y: 400 }
    })
    expect(result.ok).toBe(true)
    expect(calls.evals.some((expression) => expression.includes('window.scrollBy(0, 400)'))).toBe(
      true
    )
  })

  it('elementInfo hits the element whose rect contains the point', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const hit = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'elementInfo', x: 20, y: 28 }
    })
    expect(hit.ok).toBe(true)
    expect(hit.element).toMatchObject({ ref: 'e1' })
    const miss = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'elementInfo', x: 900, y: 900 }
    })
    expect(miss.element).toBeUndefined()
  })

  it('evaluate returns the JSON-parsed page value', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'evaluate', expression: '1 + 1' }
    })
    expect(result.ok).toBe(true)
    // The fake surface always answers the sample snapshot JSON.
    expect(result.value).toMatchObject({ url: 'https://example.org/page' })
  })

  it('waitFor(selector) parks on the surface wait', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'waitFor', selector: '#result', timeoutMs: 3000 }
    })
    expect(result.ok).toBe(true)
    expect(calls.waited).toEqual([{ selector: '#result', page: 'page-1' }])
  })

  it('waitFor(textGone) is honestly unsupported', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'waitFor', textGone: 'Loading' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('capability_unsupported')
  })
})

describe('ZcodeBrowserBackend.execute viewport hygiene', () => {
  it('scrolls the element into view before a positional click', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e1' }
    })
    expect(result.ok).toBe(true)
    expect(calls.scrolledIntoView).toEqual(['body > a:nth-of-type(1)'])
    expect(calls.clicked).toEqual(['body > a:nth-of-type(1)'])
  })

  it('answers listUserTabs with an honest empty array', async () => {
    const calls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'listUserTabs' }
    })
    expect(result).toMatchObject({ ok: true, userTabs: [] })
  })
})

describe('ZcodeBrowserBackend.execute click false-negative recovery', () => {
  it('reports success when a failed click demonstrably navigated', async () => {
    const calls = surfaceCalls()
    const surface = fakeSurface(calls, {
      browserClick: vi.fn(async () => {
        throw Object.assign(new Error("Cannot read properties of null (reading 'clientWidth')"), {
          code: 'browser_error'
        })
      }) as never,
      browserEval: (() => {
        // The navigate before the click still collects a snapshot; only the
        // post-click verification read must see the navigated URL.
        let evals = 0
        return vi.fn(async () => {
          evals += 1
          return evals <= 1
            ? { result: sampleEvalResult(), origin: 'https://example.org' }
            : {
                result: '"https://www.iana.org/help/example-domains"',
                origin: 'https://www.iana.org'
              }
        })
      })() as never
    })
    const backend = new ZcodeBrowserBackend(() => surface)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'navigate', url: 'https://example.org' }
    })
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e1' }
    })
    expect(result.ok).toBe(true)
  })

  it('keeps the error when the page did not move', async () => {
    const calls = surfaceCalls()
    const surface = fakeSurface(calls, {
      browserClick: vi.fn(async () => {
        throw new Error('click exploded without navigating')
      }) as never
    })
    const backend = new ZcodeBrowserBackend(() => surface)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'navigate', url: 'https://example.org' }
    })
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e1' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('click exploded')
  })
})
