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
        if (message.params.content === 'AUTO') {
          const s = message.params.sessionId
          const ts = Date.now()
          send({ method: 'session/event', params: { type: 'turn.started', turnId: 'turn_auto', sessionId: s, seq: 1, timestamp: ts, payload: {} } })
          send({
            id: 'auto-1',
            method: 'automation/create',
            params: {
              title: 'greeter',
              prompt: 'say hi',
              cronExpr: '* * * * *',
              recurring: true,
              targetTaskId: s
            }
          })
          return send({ id: message.id, result: { accepted: true } })
        }
      if (message.params.content === 'ASK') {
        // A turn that blocks on AskUserQuestion: the tool opens, then the
        // server asks the client to answer; the turn ends only once answered.
        if (message.params.content === 'LONG') {
        // A long turn: opens and streams, and only the server's stop ends it.
        const s = message.params.sessionId
        send({ method: 'session/event', params: { type: 'turn.started', turnId: 'turn_long', sessionId: s, seq: 1, timestamp: Date.now(), payload: {} } })
        send({ method: 'session/event', params: { type: 'model.streaming', turnId: 'turn_long', sessionId: s, seq: 2, timestamp: Date.now(), payload: { assistantMessageId: 'msg_long', delta: 'working', kind: 'text_delta' } } })
        return send({ id: message.id, result: { accepted: true } })
      }
      const ts = Date.now()
        const questions = [
          {
            question: '你喝什么？',
            header: '饮品',
            multiSelect: false,
            options: [
              { value: '咖啡', label: '咖啡' },
              { value: '茶', label: '茶' }
            ]
          }
        ]
        send({ method: 'session/event', params: { type: 'turn.started', turnId: 'turn_a', sessionId: s, seq: 1, timestamp: ts, payload: {} } })
        send({ method: 'session/event', params: { type: 'model.streaming', turnId: 'turn_a', sessionId: s, seq: 2, timestamp: ts, payload: { toolCallId: 'call_ask', kind: 'tool_call', toolName: 'AskUserQuestion', input: { questions } } } })
        send({ method: 'session/event', params: { type: 'tool.updated', turnId: 'turn_a', sessionId: s, seq: 3, timestamp: ts, payload: { toolCallId: 'call_ask', toolName: 'AskUserQuestion' } } })
        send({
          id: 'ask-1',
          method: 'interaction/requestUserInput',
          params: {
            requestId: 'perm_ask1',
            sessionId: s,
            turnId: 'turn_a',
            toolCallId: 'call_ask',
            toolName: 'AskUserQuestion',
            prompt: 'Tool AskUserQuestion requires user interaction',
            questions
          }
        })
        // The real server re-asks an unanswered question every few seconds
        // under a fresh interaction id and wire id; the answer must reach the
        // NEWEST ask, or the server rejects it as already answered elsewhere.
        setTimeout(() => {
          send({
            id: 'ask-2',
            method: 'interaction/requestUserInput',
            params: {
              requestId: 'perm_ask2',
              sessionId: s,
              turnId: 'turn_a',
              toolCallId: 'call_ask',
              toolName: 'AskUserQuestion',
              prompt: 'Tool AskUserQuestion requires user interaction',
              questions
            }
          })
        }, 300)
        return send({ id: message.id, result: { accepted: true } })
      }
      const ts = Date.now()
      send({ method: 'session/event', params: { type: 'turn.started', turnId: 'turn_1', sessionId: s, seq: 1, timestamp: ts, payload: { input: message.params.content } } })
      // The real protocol streams reasoning and reply under ONE message id.
      send({ method: 'session/event', params: { type: 'model.streaming', turnId: 'turn_1', sessionId: s, seq: 2, timestamp: ts, payload: { assistantMessageId: 'msg_reply', delta: 'thinking hard', kind: 'reasoning_delta' } } })
      send({ method: 'session/event', params: { type: 'model.streaming', turnId: 'turn_1', sessionId: s, seq: 3, timestamp: ts, payload: { assistantMessageId: 'msg_reply', delta: 'hello back', kind: 'text_delta' } } })
      send({ method: 'session/event', params: { type: 'turn.completed', turnId: 'turn_1', sessionId: s, seq: 4, timestamp: ts, payload: { response: 'hello back', resultType: 'success', duration: 5 } } })
      return send({ id: message.id, result: { accepted: true } })
    }
    if (message.id === 'ask-1') {
      // The first ask was superseded by a re-ask: answering it is the bug this
      // test pins, so the fake server treats a stale-ask answer as an error.
      return send({ id: message.id, error: { code: -32001, message: 'request superseded' } })
    }
    if (message.id === 'ask-2') {
      // The client answered the NEWEST interaction request: finish the tool and
      // turn with the answer echoed back, so the test can assert what we sent.
      const s = message.params?.sessionId ?? 'sess_provider_1'
      const ts = Date.now()
      const answer = JSON.stringify(message.result ?? message.error ?? null)
      send({ method: 'session/event', params: { type: 'tool.updated', turnId: 'turn_a', sessionId: s, seq: 4, timestamp: ts, payload: { toolCallId: 'call_ask', toolName: 'AskUserQuestion', result: { success: true, content: { head: 'answered ' + answer, byteLength: answer.length, truncated: false } } } } })
      send({ method: 'session/event', params: { type: 'turn.completed', turnId: 'turn_a', sessionId: s, seq: 5, timestamp: ts, payload: { response: 'the user chose ' + answer, resultType: 'success', duration: 1 } } })
      return
    }
    if (message.id === 'auto-1') {
      // The client answered automation/create: finish the turn.
      const s = 'sess_provider_1'
      const ts = Date.now()
      const answer = JSON.stringify(message.result ?? message.error ?? null)
      send({ method: 'session/event', params: { type: 'turn.completed', turnId: 'turn_auto', sessionId: s, seq: 2, timestamp: ts, payload: { response: 'created ' + answer, resultType: 'success', duration: 1 } } })
      return
    }
    if (message.method === 'session/stop') {
      const s = message.params?.sessionId ?? 'sess_provider_1'
      send({ method: 'session/event', params: { type: 'turn.failed', turnId: 'turn_long', sessionId: s, seq: 3, timestamp: Date.now(), payload: { error: 'stopped by user' } } })
      return send({ id: message.id, result: {} })
    }
    if (message.method === 'session/goal') {
      const action = message.params.action
      return send({
        id: message.id,
        result: {
          response:
            action === 'set'
              ? 'Goal active\\nObjective: ' + message.params.objective
              : 'No goal is set.'
        }
      })
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

  it('routes the /goal builtin to its protocol method, not the model', async () => {
    const rig = await openZcodeHostRig()
    try {
      await expect(rig.host.attach(CALLER, attachParams())).resolves.toMatchObject({ ok: true })
      const outcome = await rig.adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: 'goal-1',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/goal ship the app' }]
        },
        fence: 1
      })
      expect(outcome).toMatchObject({ state: 'accepted' })
      await vi.waitFor(
        async () => {
          const messages = await rig.messages()
          const flat = messages.join(' ')
          // The command's own answer is the turn's message row.
          expect(flat).toContain('Goal active')
          expect(flat).toContain('ship the app')
          const turns = (
            await rig.host.history({ sessionId: SESSION, direction: 'tail' })
          ).page.items.filter((row) => row.body.kind === 'turn')
          const turn = turns.at(-1)?.body as { state?: string } | undefined
          expect(turn?.state).toBe('completed')
        },
        { timeout: 10_000 }
      )
    } finally {
      await rig.host.close(SESSION, 'user-close')
    }
  })

  it('answers an AskUserQuestion card through the host and delivers the answers to the server', async () => {
    const rig = await openZcodeHostRig()
    try {
      await expect(rig.host.attach(CALLER, attachParams())).resolves.toMatchObject({ ok: true })
      const ask = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'ASK' }]
      }
      await rig.host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: ask }),
        body: ask
      })
      const card = await vi.waitFor(
        async () => {
          const items = (await rig.host.history({ sessionId: SESSION, direction: 'tail' })).page
            .items
          const question = items.find((row) => row.body.kind === 'question')
          expect(question).toBeDefined()
          return question as { itemId: string; revision: number }
        },
        { timeout: 10_000 }
      )
      // A person reads the options before answering: let the server's re-ask
      // (a fresh interaction id, 300ms in) land first, as it always does live.
      await new Promise((resolve) => setTimeout(resolve, 700))
      // The renderer's exact path: answer with the card's revision, as answers.
      const answers = [{ questionId: 'q0', optionIds: ['咖啡'] }]
      const fields = { itemId: card.itemId, expectedRevision: card.revision, answers }
      const result = await rig.host.respondToPrompt(CALLER, {
        envelope: envelope('agentSession.respondTo:question', fields),
        kind: 'question',
        ...fields
      })
      expect(result).toMatchObject({
        ok: true,
        value: { resolution: { state: 'resolved', answers } }
      })
      // The server received the answers-by-question-text shape and the turn
      // it unblocked completes with the answer echoed in the reply. Read the
      // journal directly: the conversation winds down once the last dispatch
      // settles, after which host.history refuses ownership.
      await vi.waitFor(
        () => {
          const { DatabaseSync } = require('node:sqlite')
          const db = new DatabaseSync(
            require('node:path').join(rig.state.root, 'agent-session-journal.db'),
            { readOnly: true }
          )
          const rows = db
            .prepare(
              "select row_json from journal_rows where session_id = ? and row_json like '%the user chose%' order by seq"
            )
            .all(SESSION) as { row_json: string }[]
          const reply = rows.map((row) => row.row_json).join('\n')
          if (!reply.includes('the user chose')) {
            const all = db
              .prepare('select seq, row_json from journal_rows where session_id = ? order by seq')
              .all(SESSION) as { seq: number; row_json: string }[]
            console.info(
              '[ask-rows]',
              all
                .map((row) => {
                  const parsed = JSON.parse(row.row_json) as {
                    kind?: string
                    body?: { kind?: string; state?: string }
                  }
                  return `${row.seq}:${parsed.kind ?? parsed.body?.kind ?? '?'}`
                })
                .join(' ')
            )
          }
          db.close()
          expect(reply).toContain('the user chose')
          expect(reply).toContain('咖啡')
        },
        { timeout: 15_000 }
      )
      // The turn's completion is asserted against the journal itself: the
      // conversation can wind down the moment the last dispatch settles, after
      // which the host's history reads refuse ownership. The batch that ends
      // the turn must carry the row's NEXT revision — a same-or-lower revision
      // replays as stale and the turn row would run forever.
      await vi.waitFor(
        () => {
          const { DatabaseSync } = require('node:sqlite')
          const db = new DatabaseSync(
            require('node:path').join(rig.state.root, 'agent-session-journal.db'),
            { readOnly: true }
          )
          const rows = db
            .prepare(
              "select row_json from journal_rows where session_id = ? and row_json like '%lifecycle-batch%' order by seq"
            )
            .all(SESSION) as { row_json: string }[]
          db.close()
          const ended = rows
            .map(
              (row) =>
                JSON.parse(row.row_json) as {
                  mutations?: {
                    itemId?: string
                    revision?: number
                    body?: { kind?: string; state?: string }
                  }[]
                }
            )
            .flatMap((batch) => batch.mutations ?? [])
            .find(
              (mutation) =>
                mutation.itemId?.includes('turn-lifecycle') &&
                mutation.body?.kind === 'turn' &&
                mutation.body?.state === 'completed'
            )
          expect(ended?.revision).toBe(2)
        },
        { timeout: 20_000 }
      )
    } finally {
      await rig.host.close(SESSION, 'user-close')
    }
  }, 45_000)

  it('switches the live permission mode of a running session and reads it back', async () => {
    const rig = await openZcodeHostRig()
    try {
      await expect(rig.host.attach(CALLER, attachParams())).resolves.toMatchObject({ ok: true })
      const ask = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'hello' }]
      }
      await rig.host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: ask }),
        body: ask
      })
      await vi.waitFor(
        async () => {
          const messages = await rig.messages()
          expect(messages.join('\n')).toContain('hello back')
        },
        { timeout: 10_000 }
      )
      // The chat starts full-access; a live pick switches the running session.
      const fields = { key: 'permissionMode', value: 'ask' }
      const result = await rig.host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', fields),
        ...fields
      })
      expect(result).toMatchObject({ ok: true })
      // The options read answers with the LIVE mode, not the launch intent.
      const options = await rig.host.readOptions(SESSION)
      expect(options.current.permissionMode).toBe('ask')
    } finally {
      await rig.host.close(SESSION, 'user-close')
    }
  }, 45_000)

  it('settles a stopped turn and takes the next send', async () => {
    const rig = await openZcodeHostRig()
    try {
      await expect(rig.host.attach(CALLER, attachParams())).resolves.toMatchObject({ ok: true })
      const long = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'LONG' }]
      }
      await rig.host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: long }),
        body: long
      })
      // The long turn is running when the person stops it.
      await vi.waitFor(
        async () => {
          const turns = (
            await rig.host.history({ sessionId: SESSION, direction: 'tail' })
          ).page.items.filter((row) => row.body.kind === 'turn')
          expect(turns.length).toBeGreaterThan(0)
        },
        { timeout: 10_000 }
      )
      const stopped = await rig.host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', {})
      })
      expect(stopped.ok).toBe(true)
      // The stopped turn settles as interrupted (never stuck running), and the
      // working clock stops.
      await vi.waitFor(
        async () => {
          const turns = (
            await rig.host.history({ sessionId: SESSION, direction: 'tail' })
          ).page.items.filter((row) => row.body.kind === 'turn')
          const turn = turns.at(-1)?.body as { state?: string } | undefined
          // A person's stop is a clean end: completed or interrupted, never running.
          expect(turn?.state === 'completed' || turn?.state === 'interrupted').toBe(true)
        },
        { timeout: 10_000 }
      )
      // The session still takes the next send after a stop.
      const again = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'hello' }]
      }
      await rig.host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: again }),
        body: again
      })
      await vi.waitFor(
        async () => {
          const messages = await rig.messages()
          expect(messages.join('\n')).toContain('hello back')
        },
        { timeout: 10_000 }
      )
    } finally {
      await rig.host.close(SESSION, 'user-close')
    }
  }, 45_000)

  it('answers automation/create in the wire record shape and lists it back', async () => {
    const rig = await openZcodeHostRig()
    try {
      await expect(rig.host.attach(CALLER, attachParams())).resolves.toMatchObject({ ok: true })
      const auto = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'AUTO' }]
      }
      await rig.host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: auto }),
        body: auto
      })
      await vi.waitFor(
        async () => {
          const messages = await rig.messages()
          expect(messages.join('\n')).toContain('created')
        },
        { timeout: 10_000 }
      )
      // The store answered the wire contract; the adapter's own store is the default idle one,
      // and the turn the fake child completed carried the record.
      const adapter = rig.adapter as unknown as {
        automationStore: { list(): { title: string; lifecycleStatus: string }[] }
      }
      const listed = adapter.automationStore.list()
      expect(
        listed.some((record) => record.title === 'greeter' && record.lifecycleStatus === 'active')
      ).toBe(true)
    } finally {
      await rig.host.close(SESSION, 'user-close')
    }
  }, 45_000)

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
          // The working clock stops: no running turn, no owed send, status idle.
          await vi.waitFor(
            () => {
              const summary = rig.host.readStatusSummary(SESSION)
              console.info('[zcode-status]', JSON.stringify(summary).slice(0, 200))
              expect(summary?.status).not.toBe('working')
            },
            { timeout: 10_000 }
          )
        },
        { timeout: 10_000 }
      )
    } finally {
      await rig.host.close(SESSION, 'user-close')
    }
  })
})
