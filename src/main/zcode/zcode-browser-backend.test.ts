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
      vi.fn(async () => ({ data: 'aGk=', format: 'png' as const }))
  } as unknown as ZcodeBrowserCommandSurface
}

describe('ZcodeBrowserBackend.list', () => {
  it('offers the Orca backend when the host lends a surface', () => {
    const backend = new ZcodeBrowserBackend(() =>
      fakeSurface({ created: [], closed: [], gotos: [], evals: [] })
    )
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
    const backend = new ZcodeBrowserBackend(() =>
      fakeSurface({ created: [], closed: [], gotos: [], evals: [] })
    )
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: 'cdp:someone-else',
      command: { method: 'list' }
    })
    expect(result.error?.code).toBe('backend_unavailable')
  })

  it('newTab registers an Orca page as a zcode tab', async () => {
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const backend = new ZcodeBrowserBackend(() =>
      fakeSurface({ created: [], closed: [], gotos: [], evals: [] })
    )
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'recordingStart' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('capability_unsupported')
  })

  it('maps surface timeout errors to the zcode timeout code', async () => {
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const calls: SurfaceCalls = { created: [], closed: [], gotos: [], evals: [] }
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
    const backend = new ZcodeBrowserBackend(() =>
      fakeSurface({ created: [], closed: [], gotos: [], evals: [] })
    )
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
    const backend = new ZcodeBrowserBackend(() =>
      fakeSurface({ created: [], closed: [], gotos: [], evals: [] })
    )
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
