import { describe, expect, it, vi } from 'vitest'

import { ZcodeBrowserBackend, answerZcodeBrowserWireRequest } from './zcode-browser-backend'
import { fakeSurface, surfaceCalls, type SurfaceCalls } from './zcode-browser-test-surface'

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
