import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isZcodeAppServerRequestError,
  openZcodeAppServerConnection,
  type ZcodeAppServerConnection
} from './zcode-app-server-connection'
import { isZcodeAppServerUnsupportedError } from './zcode-app-server-session'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * A real `node -e` child speaking the ZCode Protocol's NDJSON framing. No
 * initialize handshake exists, so the first line may already be a request.
 * `test/ask` pushes a server request; `test/hello` answers with params echoed.
 */
const FAKE_ZCODE_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'test/hello') return send({ id: message.id, result: { echo: message.params } })
    if (message.method === 'test/notify') {
      send({ method: 'session/event', params: { type: 'turn.started', payload: {}, seq: 1 } })
      return send({ id: message.id, result: {} })
    }
    if (message.method === 'test/ask') {
      send({ id: 7, method: 'interaction/requestPermission', params: { requestId: 'perm-1' } })
      return send({ id: message.id, result: {} })
    }
    if (message.id === 7) {
      return send({ method: 'test/answered', params: message })
    }
    if (message.method === 'test/refuse') {
      return send({ id: message.id, error: { code: -32602, message: 'bad params' } })
    }
    if (message.method === 'test/missing') {
      return send({ id: message.id, error: { code: -32601, message: 'Method not found: test/missing' } })
    }
  })
`

async function openFakeServer(
  handlers: Parameters<typeof openZcodeAppServerConnection>[1] = {}
): Promise<ZcodeAppServerConnection> {
  return openZcodeAppServerConnection(
    { command: process.execPath, args: ['-e', FAKE_ZCODE_SERVER] },
    handlers
  )
}

describe('openZcodeAppServerConnection', () => {
  it('answers a request over the transport with no handshake', async () => {
    const connection = await openFakeServer()
    try {
      await expect(connection.request('test/hello', { a: 1 })).resolves.toEqual({ echo: { a: 1 } })
    } finally {
      await connection.close()
    }
  })

  it('delivers notifications to the handler', async () => {
    const events: unknown[] = []
    const connection = await openFakeServer({
      onNotification: (method, params) => events.push({ method, params })
    })
    try {
      await connection.request('test/notify')
      expect(events).toEqual([
        { method: 'session/event', params: { type: 'turn.started', payload: {}, seq: 1 } }
      ])
    } finally {
      await connection.close()
    }
  })

  it('maps a -32601 reply to the unsupported error class', async () => {
    const connection = await openFakeServer()
    try {
      const error = await connection.request('test/missing').catch((caught: unknown) => caught)
      expect(isZcodeAppServerUnsupportedError(error)).toBe(true)
    } finally {
      await connection.close()
    }
  })

  it('surfaces a refused request with its error code', async () => {
    const connection = await openFakeServer()
    try {
      const error: unknown = await connection.request('test/refuse').catch((caught) => caught)
      expect(isZcodeAppServerRequestError(error)).toBe(true)
      if (isZcodeAppServerRequestError(error)) {
        expect(error.code).toBe(-32602)
      }
    } finally {
      await connection.close()
    }
  })

  it('answers an unhandled server request with -32601 rather than ignoring it', async () => {
    const answered: { method: string; params: unknown }[] = []
    const connection = await openFakeServer({
      onNotification: (method, params) => {
        if (method === 'test/answered') {
          answered.push({ method, params })
        }
      }
    })
    try {
      await connection.request('test/ask')
      // The fake server relays whatever Orca answered for request id 7.
      await vi.waitFor(() => {
        expect(answered).toEqual([
          {
            method: 'test/answered',
            params: {
              id: 7,
              error: { code: -32601, message: 'Method not found: interaction/requestPermission' }
            }
          }
        ])
      })
    } finally {
      await connection.close()
    }
  })

  it('lets a handler answer the server request itself', async () => {
    const answered: { method: string; params: unknown }[] = []
    const connection = await openFakeServer({
      onServerRequest: (request) => connection.respond(request.id, { decision: 'allow' }),
      onNotification: (method, params) => {
        if (method === 'test/answered') {
          answered.push({ method, params })
        }
      }
    })
    try {
      await connection.request('test/ask')
      await vi.waitFor(() => {
        expect(answered).toEqual([
          { method: 'test/answered', params: { id: 7, result: { decision: 'allow' } } }
        ])
      })
    } finally {
      await connection.close()
    }
  })

  it('fails in-flight requests when the child dies unexpectedly', async () => {
    const connection = await openFakeServer()
    // test/hello never replies until asked, so the kill races a pending call.
    const pending = connection.request('test/hello', undefined, { timeoutMs: 5_000 })
    process.kill(connection.pid!, 'SIGKILL')
    await expect(pending).rejects.toThrow()
    // The kill was observed first-hand, so the close proves the exit it already saw.
    expect(await connection.close()).toBe(true)
  })
})
