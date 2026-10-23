// The structured-session adapter for ZCode: one `zcode app-server` child per
// session, driven over the ZCode Protocol (NDJSON JSON-RPC). This first slice
// owns acquire end to end — launch, version gate, connect, session/create or
// session/resume, subscribe, snapshot seeding — and the transport event pump.
// The remaining turn surface (dispatch, cancel, prompts, options) lands in the
// follow-up commits of this branch.

import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  readZcodeCommands,
  readZcodeLiveOptions,
  readZcodeRestingOptions
} from './zcode-structured-options'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
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
import { cancelZcodeTurn, compactZcodeTurn, dispatchZcodeTurn } from './zcode-structured-turns'
import { ZcodeAutomationStore } from './zcode-automation-store'
import type { ZcodeBrowserBackend } from './zcode-browser-backend'
import { routeZcodeServerRequest } from './zcode-server-requests'
import { ZcodeStructuredLane } from './zcode-structured-lane'
import { supportsZcodeStructuredLocation } from './zcode-structured-location-support'
import {
  readZcodeSnapshotCommands,
  readZcodeSnapshotEfforts,
  readZcodeSnapshotEventSeq,
  readZcodeSnapshotModels,
  readZcodeSnapshotOptions,
  setZcodeSessionOption,
  zcodeSessionLifecycle
} from './zcode-session-lifecycle'
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
  reportedOptions: Record<string, string>
  /** The provider's own model listing from the snapshot. */
  reportedModels: { id: string; label: string }[]
  /** Each model's reasoning levels from the snapshot. */
  reportedEfforts: Map<string, { value: string; label: string }[]>
  /** The provider's own slash-command surface from the snapshot. */
  reportedCommands: { name: string; description?: string; argumentHint?: string }[]
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
  /** The provider settled a dispatch after its request returned. */
  onDispatchSettledLate?: (
    settlement: Parameters<StructuredAgentSessionHost['settleLateDispatch']>[0]
  ) => void
  /** automation/* answers; defaults to an idle store. */
  automation?: ZcodeAutomationStore
  /** browser-use answers; absent degrades to an honest empty discovery. */
  browser?: ZcodeBrowserBackend
  /** Held sends changed with no row: every reader re-derives current work. */
  onWorkChanged?: (sessionId: string) => void
}

const ZCODE_SUBSCRIBE_DELIVERY = 'desktop-continuous'

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  supportsLocation = supportsZcodeStructuredLocation

  private readonly sessions = new Map<string, ZcodeSession>()

  constructor(private readonly deps: ZcodeStructuredSessionAdapterDeps) {}
  private readonly defaultAutomation = new ZcodeAutomationStore({ fire: () => {} })
  private get automationStore(): ZcodeAutomationStore {
    return this.deps.automation ?? this.defaultAutomation
  }

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
      connection.respondWithError(request.id, -32601, `Method not found: ${request.method}`)
      return
    }
    routeZcodeServerRequest(session, sessionId, request, connection, {
      automation: this.automationStore,
      ...(this.deps.browser ? { browser: this.deps.browser } : {})
    })
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
      const snapshot = (await zcodeSessionLifecycle(
        connection,
        launch,
        launch.resumeSessionId,
        input.options,
        input.permissionMode
      )) as {
        session?: { sessionId?: string }
        settings?: Record<string, unknown>
        runtime?: Record<string, unknown>
        slashCommands?: unknown
      }
      const providerSessionId = snapshot.session?.sessionId
      if (typeof providerSessionId !== 'string' || !providerSessionId.startsWith('sess_')) {
        throw new Error('zcode app-server returned a snapshot without a session id')
      }
      const lane = new ZcodeStructuredLane(
        (settlement) => {
          void this.deps.onDispatchSettledLate?.(settlement)
          queueMicrotask(() => this.deps.onWorkChanged?.(settlement.sessionId))
        },
        {
          events: input.events,
          sessionId,
          generation: input.identity.sessionId,
          providerSessionId
        }
      )
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
        reportedOptions: readZcodeSnapshotOptions(snapshot),
        reportedModels: readZcodeSnapshotModels(snapshot),
        reportedEfforts: readZcodeSnapshotEfforts(snapshot),
        reportedCommands: readZcodeSnapshotCommands(snapshot),
        lane
      }
      lane.seedSeq(readZcodeSnapshotEventSeq(snapshot))
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
        // The store's link ids allow [A-Za-z0-9_-] only: no separators like ':'.
        linkId: randomUUID(),
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

  dispatch = (
    input: Parameters<typeof dispatchZcodeTurn>[1]
  ): Promise<AgentSessionDispatchOutcome> =>
    dispatchZcodeTurn(this.live(input.sessionId), input, this.deps.requestTimeoutMs ?? 30_000)

  compact: StructuredAgentSessionAdapter['compact'] = async (input) =>
    compactZcodeTurn(this.live(input.sessionId), this.deps.requestTimeoutMs ?? 30_000)

  cancelTurn = (input: { sessionId: string; turnId?: string; fence: number }) =>
    cancelZcodeTurn(this.live(input.sessionId))

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

  setOption = async (
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> => {
    const session = this.live(input.sessionId)
    // The chat's permission picker names the Orca mode; the protocol option is 'mode'.
    await setZcodeSessionOption(
      session,
      input.key === 'permissionMode' ? 'mode' : input.key,
      input.value
    )
    // The full updated set: the host persists what this returns, and a void
    // here would wipe every other option the session holds.
    // Only the string-valued options persist; the rest of the report is display state.
    const strings = (e: unknown[]): e is [string, string] => typeof e[1] === 'string'
    return Object.fromEntries(Object.entries(readZcodeLiveOptions(session).current).filter(strings))
  }

  readOptions = (input: { sessionId: string; fence: number }) =>
    Promise.resolve(readZcodeLiveOptions(this.live(input.sessionId)))

  readAcquisitionOptions = (input: {
    sessionId: string
    fence: number
    priorOptions?: Readonly<Record<string, string>>
  }) => readZcodeRestingOptions(this.sessions.get(input.sessionId), input.priorOptions)

  readCommands = (sessionId: string) => readZcodeCommands(this.sessions.get(sessionId))

  holdsLiveProviderProcess = (sessionId: string, acquisitionGeneration: string): boolean => {
    const session = this.sessions.get(sessionId)
    return (
      session?.acquisitionGeneration === acquisitionGeneration &&
      session.connection.pid !== undefined &&
      !session.ended
    )
  }

  /** True while the child runs a turn; a pinned-true answer would never let the
   *  host's idle sweep stop an idle zcode child. A held question counts too:
   *  its turn stays open on the provider's side, blocked on a person. */
  holdsDispatch = (sessionId: string): boolean => {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.ended) {
      return false
    }
    return session.lane.assembler.openTurnId !== null || session.lane.pendingPrompts.size > 0
  }

  closeSession = async (sessionId: string): Promise<boolean> => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    this.sessions.delete(sessionId)
    session.ended = true
    // The provider session is gone: its browser pages are nobody's to keep.
    void this.deps.browser?.releaseSession(session.providerSessionId)
    const closed = await session.connection.close()
    return closed
  }

  forceCloseSession = async (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  disposeSession = async (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  acknowledgeSessionRelease = (sessionId: string): void => {
    this.sessions.delete(sessionId)
  }

  closeAll = async (): Promise<void> =>
    void (await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id))))

  private live(sessionId: string): ZcodeSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      throw new Error(`no live zcode app-server session for ${sessionId}`)
    }
    return session
  }
}
