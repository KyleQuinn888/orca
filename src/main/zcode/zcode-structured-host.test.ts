import { afterEach, describe, expect, it, vi } from 'vitest'

import { hello } from '../acp/acp-structured-host.test-support'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import {
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { messageText } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { AgentSessionRecoveryCapsule } from '../runtime/agent-session-recovery-capsule'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import { ZCODE_STRUCTURED_AGENT } from './zcode-structured-agent-definition'
import type { ComposedStructuredLaunch } from '../runtime/structured-agent-launch-composition'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The protocol subset the adapter drives, with a replying turn on send. */
const FAKE_ZCODE_APP_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'session/create' || message.method === 'session/resume') {
      const sessionId = message.method === 'session/resume' ? message.params.sessionId : 'sess_provider_1'
      send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { sessionId } })
      return send({ id: message.id, result: { session: { sessionId } } })
    }
    if (message.id === 'server-1') {
      return send({ method: 'test/prefsAnswer', params: message })
    }
    if (message.method === 'session/subscribe') {
      return send({ id: message.id, result: { eventSeq: 0 } })
    }
    if (message.method === 'session/send') {
      const s = message.params.sessionId
      const ts = Date.now()
      send({ method: 'session/event', params: { type: 'turn.started', turnId: 'turn_1', sessionId: s, seq: 1, timestamp: ts, payload: { input: message.params.content } } })
      // The real protocol streams reasoning and reply under ONE message id.
      send({ method: 'session/event', params: { type: 'model.streaming', turnId: 'turn_1', sessionId: s, seq: 2, timestamp: ts, payload: { assistantMessageId: 'msg_reply', delta: 'thinking hard', kind: 'reasoning_delta' } } })
      send({ method: 'session/event', params: { type: 'model.streaming', turnId: 'turn_1', sessionId: s, seq: 3, timestamp: ts, payload: { assistantMessageId: 'msg_reply', delta: 'hello back', kind: 'text_delta' } } })
      send({ method: 'session/event', params: { type: 'turn.completed', turnId: 'turn_1', sessionId: s, seq: 4, timestamp: ts, payload: { response: 'hello back', resultType: 'success', duration: 5 } } })
      return send({ id: message.id, result: { accepted: true } })
    }
    if (message.method === 'session/stop') {
      return send({ id: message.id, result: {} })
    }
    return send({ id: message.id, result: {} })
  })
`

const attachParams = (fence: number | null = null) =>
  hostTestAttachParams(fence, {
    provider: 'zcode',
    agent: 'zcode',
    accountHome: { variable: 'ZCODE_STORAGE_DIR', path: 'C:/zcode-home' },
    providerHandle: undefined
  })

async function openZcodeHostRig() {
  const state = hostTestState()
  const store = await openTestAgentSessionRecordStore(state.root)
  const journalDatabase = openTestJournalHostDatabase(state.root)
  const hosted: { host: StructuredAgentSessionHost | null } = { host: null }
  const launch: ComposedStructuredLaunch<ZcodeStructuredLaunch> = {
    command: process.execPath,
    args: ['-e', FAKE_ZCODE_APP_SERVER],
    cwd: process.cwd(),
    env: {},
    envToDelete: [],
    resumeSessionId: null
  }
  const adapter = new ZcodeStructuredSessionAdapter({
    resolveLaunch: async () => launch,
    readProcessStartTime: async () => 1_700_000_000_000,
    onEvent: (event) => void hosted.host?.handleAdapterEvent(event),
    onWorkChanged: (sessionId) => hosted.host?.publishWorkChanged(sessionId),
    onDispatchSettledLate: (settlement) => void hosted.host?.settleLateDispatch(settlement as never)
  })
  const host = new StructuredAgentSessionHost({
    agents: new StructuredAgentRegistry([{ definition: ZCODE_STRUCTURED_AGENT, adapter }]),
    logger: state.log.logger,
    store,
    adapter,
    journalDatabase,
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  hosted.host = host
  replaceHostTestState({ store, host })
  const messages = async () =>
    (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
      .filter((row) => row.body.kind === 'message')
      .map((row) => messageText(row.body))
  return { host, adapter, state, messages }
}

describe('Zcode behind the real structured-session host', () => {
  it('publishes the settled turn to subscribers (the renderer path)', async () => {
    const rig = await openZcodeHostRig()
    const seenTurnEnds: unknown[] = []
    const unsubscribe = rig.host.subscribeTurnCompletions({
      id: 'zcode-test',
      emit: (event) => {
        seenTurnEnds.push(event)
      }
    })
    try {
      await expect(rig.host.attach(CALLER, attachParams())).resolves.toMatchObject({ ok: true })
      await rig.host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: hello }),
        body: hello
      })
      await vi.waitFor(
        () => {
          expect(seenTurnEnds.length).toBeGreaterThan(0)
        },
        { timeout: 10_000 }
      )
    } finally {
      unsubscribe()
      await rig.host.close(SESSION, 'user-close')
    }
  })

  it('attaches and delivers a send end to end', async () => {
    const rig = await openZcodeHostRig()
    try {
      await expect(rig.host.attach(CALLER, attachParams())).resolves.toMatchObject({ ok: true })
      await rig.host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: hello }),
        body: hello
      })
      await vi.waitFor(
        async () => {
          const messages = await rig.messages()
          // The reply is its own row, and the reasoning row survived as its own.
          expect(messages.join('\n')).toContain('hello back')
          expect(messages.join('\n')).toContain('thinking hard')
          // The turn settles with the provider's verdict: the working clock stops.
          const turns = (
            await rig.host.history({ sessionId: SESSION, direction: 'tail' })
          ).page.items.filter((row) => row.body.kind === 'turn')
          expect(turns.length).toBeGreaterThan(0)
          const turn = turns.at(-1)?.body as { state: string; outcome?: string } | undefined
          expect(turn?.state).toBe('completed')
          expect(turn?.outcome).toBe('success')
        },
        { timeout: 10_000 }
      )
    } finally {
      await rig.host.close(SESSION, 'user-close')
    }
  })
})
