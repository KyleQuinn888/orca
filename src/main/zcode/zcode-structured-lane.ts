// One zcode child's timeline: protocol events in, journal rows out, held
// interaction requests as the cards a person answers.
//
// The adapter owns the child and the session API; this lane owns everything a
// turn renders: the translator maps ZCode envelopes to the shared provider
// grammar, the assembler turns that grammar into journal writes through the
// sink, and held permission/user-input requests stay answerable until the
// person (or the child's death) settles them.

import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { createProviderTimelineAssembler } from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'

const RETRY_MS = 250
import type { ZcodeAppServerConnection } from './zcode-app-server-connection'

/** What a held interaction request needs to be answered over the transport. */
export type ZcodeHeldPrompt = {
  kind: 'approval' | 'question'
  requestId: number | string
}

/** An event sink with no journal behind it: the protocol still runs, the timeline drops. */
const NO_TIMELINE_EVENT_SINK = {
  tryAppendTransition: () => ({ accepted: false, reason: 'no-sink' }),
  journalItems: () => [],
  setActivity: () => {}
} as never as StructuredAgentSessionEventSink

export type ZcodeDispatchSettlement = {
  sessionId: string
  clientMessageId: string
  providerIdentity: {
    provider: 'legacy'
    agent: string
    sessionId: string
    recordId: string
  }
}

export class ZcodeStructuredLane {
  readonly translator = new ZcodeTimelineTranslator()
  readonly assembler: ReturnType<typeof createProviderTimelineAssembler>
  /** Interaction requests held for the person, by their server request id. */
  readonly pendingPrompts = new Map<string, ZcodeHeldPrompt>()
  /** The highest session/event seq applied; a re-delivered envelope drops. */
  private lastSeq = 0
  /** Events the sink refused under backpressure, re-applied until admitted. */
  private readonly retry: ProviderTimelineEvent[] = []
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** The send whose turn has not ended; its dispatch settles when the turn does. */
  private armedSend: string | null = null
  /** The provider turn id the armed send opened into. */
  private armedTurn: string | null = null
  /** A fast turn can start AND end before session/send's reply returns: the
   *  dispatch still in flight needs the identity of the turn that already ran. */
  private settledTurn: string | null = null

  /** The journal identity of the turn the armed send opened (or that already
   *  settled under it, when the whole turn raced the send's reply). */
  armedTurnIdentity(): ZcodeDispatchSettlement['providerIdentity'] | null {
    const turn = this.armedTurn ?? this.settledTurn
    if (turn === null) {
      return null
    }
    return this.identity.turn({
      namespace: this.namespace,
      key: { source: 'provider', value: turn }
    }) as ZcodeDispatchSettlement['providerIdentity']
  }
  private readonly identity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private namespace = ''
  private sessionId = ''

  constructor(
    private readonly onDispatchSettled: ((settlement: ZcodeDispatchSettlement) => void) | undefined,
    input: {
      events: StructuredAgentSessionEventSink | undefined
      sessionId: string
      generation: string
      providerSessionId: string
    }
  ) {
    this.identity = createLegacyProviderTimelineIdentityScheme({
      agent: 'zcode',
      sessionId: input.sessionId
    })
    const sink = (providerTimelineSink(input.events ?? NO_TIMELINE_EVENT_SINK) ??
      noTimelineSink()) as ProviderTimelineSink
    this.assembler = createProviderTimelineAssembler({
      sink,
      sessionId: input.sessionId,
      agent: 'zcode',
      generation: input.generation,
      namespace: input.providerSessionId
    })
  }

  /** One transport notification; session/event envelopes carry the conversation. */
  notification(method: string, params: unknown): void {
    if (method !== 'session/event' && method !== 'state.updated') {
      return
    }
    if (method === 'session/event') {
      const envelope = params as { type?: unknown; seq?: unknown }
      if (typeof envelope.seq === 'number') {
        if (envelope.seq <= this.lastSeq) {
          return
        }
        this.lastSeq = envelope.seq
      }
      this.applyAll(this.translator.translate(params as never))
      return
    }
    if (method === 'state.updated') {
      const status = (params as { patch?: { status?: string } } | undefined)?.patch?.status
      if (typeof status === 'string') {
        this.assembler.apply({
          type: 'activity',
          text: status === 'running' ? 'working' : null
        })
      }
    }
  }

  /** One session/event envelope directly (seq already guarded by the adapter). */
  event(envelope: unknown): void {
    this.applyAll(this.translator.translate(envelope as never))
  }

  /** The transport pushed a permission request: journal its card, hold the answer. */
  permissionRequest(
    connection: ZcodeAppServerConnection,
    requestId: number | string,
    params: unknown
  ): void {
    this.pendingPrompts.set(String(requestId), { kind: 'approval', requestId })
    this.applyAll(
      this.translator.translate({
        type: 'permission.requested',
        timestamp: Date.now(),
        payload: params as Record<string, unknown>
      })
    )
    void connection
  }

  /** The transport pushed a user-input request: journal its card, hold the answer. */
  userInputRequest(requestId: number | string, params: unknown): void {
    this.pendingPrompts.set(String(requestId), { kind: 'question', requestId })
    this.applyAll(
      this.translator.translate({
        type: 'userInput.requested',
        timestamp: Date.now(),
        payload: params as Record<string, unknown>
      })
    )
  }

  /** Orca's send reached the provider. */
  inputAccepted(clientMessageId: string, requestedAt: number): void {
    this.armedSend = clientMessageId
    this.settledTurn = null
    this.assembler.apply({ type: 'input.accepted', clientMessageId, requestedAt })
  }

  /** The child is gone: settle the timeline after everything it said lands. */
  sessionEnded(): void {
    this.pendingPrompts.clear()
    this.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
  }

  /** The protocol answer for the one held request, built from what the person chose. */
  answerFor(
    pending: ZcodeHeldPrompt,
    response:
      | { kind: 'option'; optionId: string }
      | { kind: 'answers'; answers: { questionId: string; optionIds: string[]; other?: string }[] }
  ): Record<string, unknown> {
    if (pending.kind === 'approval') {
      return {
        decision:
          response.kind === 'option' && response.optionId.startsWith('deny') ? 'deny' : 'allow'
      }
    }
    if (response.kind !== 'answers') {
      return { action: 'decline' }
    }
    const content = response.answers
      .map((answer) => answer.other ?? answer.optionIds.join(', '))
      .join(' ')
    return { action: 'accept', content }
  }

  private applyAll(events: readonly ProviderTimelineEvent[]): void {
    for (const event of events) {
      if (event.type === 'turn.open' && event.turn !== undefined) {
        this.armedTurn = event.turn
      }
      const applied = this.assembler.apply(event)
      if ('admission' in applied && !applied.admission.accepted) {
        // A refused turn.end would leave the row running and the clock ticking
        // until the child dies: hold it and re-apply once the sink drains.
        this.retry.push(event)
        this.scheduleRetry()
        continue
      }
      // The dispatch the armed send opened settles with its turn's end: the
      // journal row alone never releases the chat's working state.
      if (
        event.type === 'turn.end' &&
        this.armedSend !== null &&
        this.armedTurn !== null &&
        this.onDispatchSettled !== undefined
      ) {
        const identity = this.identity.turn({
          namespace: this.namespace,
          key: { source: 'provider', value: this.armedTurn }
        })
        this.settledTurn = this.armedTurn
        this.onDispatchSettled({
          sessionId: this.sessionId,
          clientMessageId: this.armedSend,
          providerIdentity: identity as ZcodeDispatchSettlement['providerIdentity']
        })
        this.armedSend = null
        this.armedTurn = null
      }
    }
    // The coalescing window holds streamed text until flushed: without this the
    // reasoning and reply rows never land and the client never hears the turn.
    this.assembler.flush()
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) {
      return
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      const held = this.retry.splice(0)
      this.applyAll(held)
    }, RETRY_MS)
  }
}

function noTimelineSink(): ProviderTimelineSink {
  const sink: ProviderTimelineSink = {
    tryAppendTransition: () => ({ accepted: false, reason: 'failed' }),
    journalItems: journalItemsStub,
    setActivity: () => {}
  }
  return sink
}

const journalItemsStub = {
  epoch: 0,
  visitItems: () => {},
  itemBody: () => null,
  item: () => undefined,
  visitItemsWithLinkage: () => {}
} as never
