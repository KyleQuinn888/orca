// The structured-session adapter for ZCode: one `zcode app-server` child per
// session, driven over the ZCode Protocol (NDJSON JSON-RPC). This first slice
// owns acquire end to end — launch, version gate, connect, session/create or
// session/resume, subscribe, snapshot seeding — and the transport event pump.
// The remaining turn surface (dispatch, cancel, prompts, options) lands in the
// follow-up commits of this branch.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import {
  AgentSessionPreSpawnError,
  AgentSessionPromptUnavailableError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionLifecycleEvent,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { randomUUID } from 'node:crypto'
import { spawnProcess } from '@orca/process-host'
import {
  openZcodeAppServerConnection,
  type ZcodeAppServerConnection
} from './zcode-app-server-connection'
import { zcodeProviderHandle } from './zcode-structured-agent-definition'
import { ZcodeStructuredLane } from './zcode-structured-lane'
import { supportsZcodeStructuredLocation } from './zcode-structured-location-support'
import { zcodeSessionLifecycle } from './zcode-session-lifecycle'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'
import type {
  ComposedStructuredLaunch,
  StructuredLaunchRequest
} from '../runtime/structured-agent-launch-composition'

/** One live zcode child and everything its turns need. */
type ZcodeSession = {
  sessionId: string
  /** The ZCode protocol session this chat drives (`sess_...`). */
  providerSessionId: string
  connection: ZcodeAppServerConnection
  acquisitionGeneration: string
  fence: number
  /** The highest session/event seq applied; a re-subscribe resumes after it. */
  lastEventSeq: number
  ended: boolean
  /** Options the acquire snapshot reported, keyed as Orca reads them. */
  reportedOptions: Readonly<Record<string, string>>
  lane: ZcodeStructuredLane
}

export type ZcodeStructuredSessionAdapterDeps = {
  /** The composed resolver the registration built from the zcode launch part. */
  resolveLaunch: (
    request: StructuredLaunchRequest
  ) => Promise<ComposedStructuredLaunch<ZcodeStructuredLaunch>>
  /** Overridden in tests. */
  spawnImpl?: PipedProcessSpawner
  readProcessStartTime?: (pid: number) => Promise<number | null>
  requestTimeoutMs?: number
  /** Lifecycle events for the host ('ended' when the child dies). */
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
}

const ZCODE_SUBSCRIBE_DELIVERY = 'desktop-continuous'

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  supportsLocation = supportsZcodeStructuredLocation

  private readonly sessions = new Map<string, ZcodeSession>()

  constructor(private readonly deps: ZcodeStructuredSessionAdapterDeps) {}

  /** Server requests: interaction requests journal through the lane; everything
   *  else declines with -32601, which the ZCode Protocol documents as the
   *  client refusing (runtime preferences fall back to defaults). */
  private handleServerRequest(
    sessionId: string,
    request: { id: number | string; method: string; params: unknown },
    connection: ZcodeAppServerConnection
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== connection) {
      console.info(`[zcode-adapter] pre-acquire request ${request.method} answered -32601`)
      connection.respondWithError(request.id, -32601, `Method not found: ${request.method}`)
      return
    }
    if (request.method === 'interaction/requestPermission') {
      session.lane.permissionRequest(session.connection, request.id, request.params)
      return
    }
    if (request.method === 'interaction/requestUserInput') {
      session.lane.userInputRequest(request.id, request.params)
      return
    }
    session.connection.respondWithError(request.id, -32601, `Method not found: ${request.method}`)
  }

  acquire = async (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> => {
    const sessionId = input.identity.sessionId
    const launch = await this.deps
      .resolveLaunch({
        identity: input.identity,
        spawnToken: input.spawnToken,
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {})
      })
      .catch((error: unknown) => {
        throw new AgentSessionPreSpawnError(error)
      })
    const identity = providerSpawnedProcessIdentity(
      {
        identity: input.identity,
        spawnToken: input.spawnToken,
        ...(input.onSpawned ? { onSpawned: input.onSpawned } : {})
      },
      'zcode-app-server',
      this.deps.readProcessStartTime
    )
    // A re-acquire of the same chat must not keep the previous child's entry:
    // its stale connection would swallow server requests meant for the new one.
    this.sessions.delete(sessionId)
    console.info(`[zcode-adapter] acquire: opening connection (resume=${launch.resumeSessionId})`)
    let expectedExit = false
    const connection = await openZcodeAppServerConnection(
      launch,
      {
        onNotification: (method, params) =>
          this.sessions.get(sessionId)?.lane.notification(method, params),
        onServerRequest: (request) => this.handleServerRequest(sessionId, request, connection),
        onExit: (error) => {
          const session = this.sessions.get(sessionId)
          if (session) {
            session.ended = true
            session.lane.sessionEnded()
          }
          this.deps.onEvent?.({
            type: 'ended',
            sessionId,
            reason: error.message,
            cause: expectedExit ? 'requested-close' : 'unexpected-exit',
            fence: session?.fence ?? 0,
            acquisitionGeneration: session?.acquisitionGeneration ?? sessionId
          })
        }
      },
      this.deps.spawnImpl ?? spawnProcess
    )
    try {
      console.info(`[zcode-adapter] acquire: connected pid=${connection.pid}, creating session`)
      const snapshot = (await zcodeSessionLifecycle(
        connection,
        launch,
        launch.resumeSessionId,
        input.options
      )) as {
        session?: { sessionId?: string }
        settings?: Record<string, unknown>
      }
      const providerSessionId = snapshot.session?.sessionId
      if (typeof providerSessionId !== 'string' || !providerSessionId.startsWith('sess_')) {
        throw new Error('zcode app-server returned a snapshot without a session id')
      }
      const lane = new ZcodeStructuredLane({
        events: input.events,
        sessionId,
        generation: input.identity.sessionId,
        providerSessionId
      })
      const session: ZcodeSession = {
        sessionId,
        providerSessionId,
        connection,
        // Host-local identity for THIS child: unique per acquisition, even when
        // the durable fence (the session id) is reused by a re-acquire.
        acquisitionGeneration: randomUUID(),
        fence: input.fence,
        lastEventSeq: 0,
        ended: false,
        reportedOptions: {},
        lane
      }
      console.info(
        `[zcode-adapter] acquire: snapshot providerSession=${providerSessionId}, subscribing`
      )
      await connection.request(
        'session/subscribe',
        {
          sessionId: providerSessionId,
          deliveryKind: ZCODE_SUBSCRIBE_DELIVERY
        },
        { timeoutMs: this.deps.requestTimeoutMs ?? 30_000 }
      )
      console.info('[zcode-adapter] acquire: subscribed, publishing')
      this.sessions.set(sessionId, session)
      const link: AgentSessionProviderHandleLink = {
        linkId: `${providerSessionId}:${input.fence}`,
        handle: zcodeProviderHandle(providerSessionId),
        origin: launch.resumeSessionId ? 'resumed' : 'created',
        mintedAtFence: input.fence,
        observedAt: Date.now()
      }
      return {
        process: await identity.read(connection.pid),
        link,
        providerChildPhase: 'ready'
      }
    } catch (error) {
      await connection.close()
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  }): Promise<AgentSessionDispatchOutcome> {
    console.info(`[zcode-adapter] dispatch: sessionId=${input.sessionId}`)
    const session = this.live(input.sessionId)
    await input.beforeDispatch?.()
    const text = input.body.blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    await session.connection.request(
      'session/send',
      { sessionId: session.providerSessionId, content: text },
      { timeoutMs: this.deps.requestTimeoutMs ?? 30_000 }
    )
    session.lane.inputAccepted(input.clientMessageId, input.requestedAt ?? Date.now())
    // The send's acceptance is the admission; turn.started settles the rest.
    return { state: 'admitted' }
  }

  /** The compaction receipt; the turn it opens ends from the event stream. */
  compact: StructuredAgentSessionAdapter['compact'] = async (input) => {
    const session = this.live(input.sessionId)
    await session.connection.request(
      'session/compact',
      { sessionId: session.providerSessionId },
      { timeoutMs: this.deps.requestTimeoutMs ?? 30_000 }
    )
    return { state: 'accepted', providerIdentity: null }
  }

  cancelTurn = async (input: { sessionId: string; turnId?: string; fence: number }) => {
    const session = this.live(input.sessionId)
    await session.connection.request('session/stop', { sessionId: session.providerSessionId })
    return { cancelled: true }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = async (input) => {
    const session = this.live(input.sessionId)
    // v1 bridge: the journal row id the host names is matched by elimination —
    // exactly one held request answers, two at once is refused until the lane
    // keeps the row ids the identity scheme mints.
    const held = [...session.lane.pendingPrompts.values()]
    if (held.length !== 1) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    await input.commit()
    session.lane.pendingPrompts.clear()
    session.connection.respond(held[0].requestId, session.lane.answerFor(held[0], input.response))
  }

  async setOption(input: StructuredAgentSessionSetOptionInput): Promise<void> {
    const session = this.live(input.sessionId)
    if (input.key === 'mode') {
      await session.connection.request('session/setMode', {
        sessionId: session.providerSessionId,
        mode: input.value
      })
      return
    }
    throw new Error(`zcode app-server has no session option named ${input.key}`)
  }

  readOptions = async (input: { sessionId: string; fence: number }) => {
    const session = this.live(input.sessionId)
    const result: AgentSessionOptionsResult = {
      current: { ...session.reportedOptions },
      // The zcode snapshot names no model listing yet; the catalog probe owns discovery.
      models: []
    }
    return result
  }

  holdsLiveProviderProcess = (sessionId: string, acquisitionGeneration: string): boolean => {
    const session = this.sessions.get(sessionId)
    return (
      session?.acquisitionGeneration === acquisitionGeneration &&
      session.connection.pid !== undefined &&
      !session.ended
    )
  }

  holdsDispatch = (sessionId: string): boolean => this.sessions.has(sessionId)

  closeSession = async (sessionId: string): Promise<boolean> => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    this.sessions.delete(sessionId)
    session.ended = true
    const closed = await session.connection.close()
    return closed
  }

  forceCloseSession = async (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  disposeSession = async (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  acknowledgeSessionRelease = (sessionId: string): void => {
    this.sessions.delete(sessionId)
  }

  closeAll = async (): Promise<void> => {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)))
  }

  private live(sessionId: string): ZcodeSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      throw new Error(`no live zcode app-server session for ${sessionId}`)
    }
    return session
  }
}
