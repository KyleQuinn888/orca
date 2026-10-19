import { afterEach, describe, expect, it, vi } from 'vitest'

import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import type { ComposedStructuredLaunch } from '../runtime/structured-agent-launch-composition'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The protocol subset the adapter drives, as one `node -e` child: no
 *  handshake, snapshot on create/resume, and a `test/permission` trigger that
 *  pushes an interaction/requestPermission server request. */
const FAKE_ZCODE_APP_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'session/create') {
      return send({ id: message.id, result: { session: { sessionId: 'sess_provider_1' } } })
    }
    if (message.method === 'session/resume') {
      if (message.params.sessionId === 'sess_missing') {
        return send({ id: message.id, error: { code: -32004, message: 'sessionUnavailable' } })
      }
      return send({ id: message.id, result: { session: { sessionId: message.params.sessionId } } })
    }
    if (message.method === 'session/subscribe') {
      return send({ id: message.id, result: { eventSeq: 0 } })
    }
    if (message.method === 'session/send') {
      if (message.params.content === 'BUSY') {
        return send({ id: message.id, error: { code: -32010, message: 'busy' } })
      }
      return send({ id: message.id, result: { accepted: true } })
    }
    if (message.method === 'session/stop') {
      return send({ id: message.id, result: {} })
    }
    if (message.method === 'session/setMode') {
      return send({ id: message.id, result: { mode: message.params.mode } })
    }
    if (message.method === 'test/permission') {
      send({ id: 'server-1', method: 'interaction/requestPermission', params: { requestId: 'perm-9', toolName: 'Bash' } })
      return send({ id: message.id, result: {} })
    }
    if (message.id === 'server-1') {
      return send({ method: 'test/permissionAnswer', params: message })
    }
  })
`

const ACQUIRE_BASE = {
  identity: {
    sessionId: 'sess_orca_1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'zcode' as const,
    providerHandle: null
  },
  fence: 1,
  spawnToken: 'spawn-1'
}

function composedLaunch(
  overrides: Partial<ZcodeStructuredLaunch> = {}
): ComposedStructuredLaunch<ZcodeStructuredLaunch> {
  return {
    command: process.execPath,
    args: ['-e', FAKE_ZCODE_APP_SERVER],
    cwd: process.cwd(),
    env: {},
    envToDelete: [],
    resumeSessionId: null,
    ...overrides
  }
}

async function openAdapter(launch = composedLaunch()) {
  const adapter = new ZcodeStructuredSessionAdapter({ resolveLaunch: async () => launch })
  return adapter
}

describe('ZcodeStructuredSessionAdapter', () => {
  it('acquires by creating a provider session and subscribing', async () => {
    const adapter = await openAdapter()
    const acquisition = await adapter.acquire({ ...ACQUIRE_BASE })
    try {
      expect(acquisition.link?.handle.nativeId).toBe('sess_provider_1')
      expect(acquisition.link?.origin).toBe('created')
      expect(acquisition.providerChildPhase).toBe('ready')
      expect(acquisition.process.pid).toBeGreaterThan(0)
    } finally {
      await adapter.closeAll()
    }
  })

  it('resumes the session the launch names', async () => {
    const adapter = await openAdapter(composedLaunch({ resumeSessionId: 'sess_provider_1' }))
    const acquisition = await adapter.acquire({ ...ACQUIRE_BASE })
    try {
      expect(acquisition.link?.handle.nativeId).toBe('sess_provider_1')
      expect(acquisition.link?.origin).toBe('resumed')
    } finally {
      await adapter.closeAll()
    }
  })

  it('fails the acquire when the provider session cannot be resumed', async () => {
    const adapter = await openAdapter(composedLaunch({ resumeSessionId: 'sess_missing' }))
    await expect(adapter.acquire({ ...ACQUIRE_BASE })).rejects.toThrow('sessionUnavailable')
    await expect(adapter.closeAll()).resolves.toBeUndefined()
  })

  it('admits a dispatch when session/send accepts', async () => {
    const adapter = await openAdapter()
    await adapter.acquire({ ...ACQUIRE_BASE })
    try {
      await expect(
        adapter.dispatch({
          sessionId: 'sess_orca_1',
          clientMessageId: 'cm-1',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '你好' }] },
          fence: 1
        })
      ).resolves.toEqual({ state: 'admitted' })
    } finally {
      await adapter.closeAll()
    }
  })

  it('cancels the turn through session/stop', async () => {
    const adapter = await openAdapter()
    await adapter.acquire({ ...ACQUIRE_BASE })
    try {
      await expect(adapter.cancelTurn({ sessionId: 'sess_orca_1', fence: 1 })).resolves.toEqual({
        cancelled: true
      })
    } finally {
      await adapter.closeAll()
    }
  })

  it('holds a permission request instead of answering it', async () => {
    const adapter = await openAdapter()
    await adapter.acquire({ ...ACQUIRE_BASE })
    try {
      // The fake server relays Orca's answer for its pushed request as a
      // notification; holding means that notification never arrives.
      const notifications: unknown[] = []
      // The dispatch that triggers test/permission rides the session/send path.
      await adapter.dispatch({
        sessionId: 'sess_orca_1',
        clientMessageId: 'cm-perm',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'test/permission' }]
        },
        fence: 1
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(notifications).toEqual([])
    } finally {
      await adapter.closeAll()
    }
  })

  it('reports the child death as an ended lifecycle event', async () => {
    const ended: { sessionId: string; cause: string }[] = []
    const launch = composedLaunch()
    const adapter = new ZcodeStructuredSessionAdapter({
      resolveLaunch: async () => launch,
      onEvent: (event) => {
        if (event.type === 'ended') {
          ended.push({ sessionId: event.sessionId, cause: event.cause })
        }
      }
    })
    const acquisition = await adapter.acquire({ ...ACQUIRE_BASE })
    process.kill(acquisition.process.pid, 'SIGKILL')
    await vi.waitFor(() => {
      expect(ended).toEqual([{ sessionId: 'sess_orca_1', cause: 'unexpected-exit' }])
    })
    expect(adapter.holdsLiveProviderProcess('sess_orca_1', ACQUIRE_BASE.identity.sessionId)).toBe(
      false
    )
  })
})
