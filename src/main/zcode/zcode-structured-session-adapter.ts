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
  type AgentSessionAcquisition,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  openZcodeAppServerConnection,
  type ZcodeAppServerConnection
} from './zcode-app-server-connection'
import { zcodeProviderHandle } from './zcode-structured-agent-definition'
import {
  zcodeVersionSupported,
  type ZcodeStructuredLaunch
} from './zcode-structured-launch-resolution'
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
}

const ZCODE_SUBSCRIBE_DELIVERY = 'desktop-continuous'
const ZCODE_ACQUIRE_TIMEOUT_MS = 60_000

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ZcodeSession>()

  constructor(private readonly deps: ZcodeStructuredSessionAdapterDeps) {}

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
    if (!(await zcodeVersionSupported(launch))) {
      throw new AgentSessionPreSpawnError(
        new Error('zcode CLI 0.16.9+ with app-server support is required'),
        { reason: 'runtimeNotInstalled' }
      )
    }
    const identity = providerSpawnedProcessIdentity(
      {
        identity: input.identity,
        spawnToken: input.spawnToken,
        ...(input.onSpawned ? { onSpawned: input.onSpawned } : {})
      },
      'zcode-app-server',
      this.deps.readProcessStartTime
    )
    const connection = await openZcodeAppServerConnection(
      launch,
      {
        onNotification: (method, params) => this.handleNotification(sessionId, method, params),
        onServerRequest: (request) => this.handleServerRequest(sessionId, request)
      },
      this.deps.spawnImpl ?? spawnProcess
    )
    try {
      const snapshot = (await this.sessionLifecycle(
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
      const session: ZcodeSession = {
        sessionId,
        providerSessionId,
        connection,
        acquisitionGeneration: input.identity.sessionId,
        fence: input.fence,
        lastEventSeq: 0,
        ended: false,
        reportedOptions: {}
      }
      await connection.request(
        'session/subscribe',
        {
          sessionId: providerSessionId,
          deliveryKind: ZCODE_SUBSCRIBE_DELIVERY
        },
        { timeoutMs: this.deps.requestTimeoutMs ?? 30_000 }
      )
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

  /** create-or-resume plus the initial settings read, as one acquire step. */
  private async sessionLifecycle(
    connection: ZcodeAppServerConnection,
    launch: ComposedStructuredLaunch<ZcodeStructuredLaunch>,
    resumeSessionId: string | null,
    options: Readonly<Record<string, string>> | undefined
  ): Promise<unknown> {
    const timeout = { timeoutMs: ZCODE_ACQUIRE_TIMEOUT_MS }
    const workspace = {
      workspacePath: launch.cwd,
      workspaceKey: launch.cwd.replaceAll('\\', '/').split('/').pop() ?? launch.cwd
    }
    const mode = options?.mode ?? 'build'
    if (resumeSessionId) {
      return await connection.request(
        'session/resume',
        { sessionId: resumeSessionId, workspace },
        timeout
      )
    }
    return await connection.request('session/create', { workspace, mode }, timeout)
  }

  /** The transport's notifications; the journal translation lands with dispatch. */
  private handleNotification(sessionId: string, method: string, params: unknown): void {
    if (method !== 'session/event' && method !== 'state.updated') {
      return
    }
    const session = this.sessions.get(sessionId)
    const envelope = params as { seq?: number } | undefined
    if (session && typeof envelope?.seq === 'number' && envelope.seq > session.lastEventSeq) {
      session.lastEventSeq = envelope.seq
    }
    void sessionId
  }

  /** Server requests the acquire relies on defaults for; permission prompts land with dispatch. */
  private handleServerRequest(
    sessionId: string,
    request: { id: number | string; method: string; params: unknown }
  ): void {
    const session = this.sessions.get(sessionId)
    // requestRuntimePreferences and MCP auth already fell back through the
    // dispatcher's -32601 default; nothing else asks before a turn runs.
    if (!session) {
      return
    }
    session.connection.respondWithError(request.id, -32601, `Method not found: ${request.method}`)
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  }): Promise<AgentSessionDispatchOutcome> {
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
    // The send's acceptance is the admission; turn.started settles the rest.
    return { state: 'admitted' }
  }

  cancelTurn = async (input: { sessionId: string; turnId?: string; fence: number }) => {
    const session = this.live(input.sessionId)
    await session.connection.request('session/stop', { sessionId: session.providerSessionId })
    return { cancelled: true }
  }

  answerPrompt = async (input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
  }): Promise<void> => {
    this.live(input.sessionId)
    throw new Error('zcode prompt answering lands with the prompt bridge')
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
    return await session.connection.close()
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
