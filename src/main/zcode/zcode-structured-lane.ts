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
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'
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

export class ZcodeStructuredLane {
  readonly translator = new ZcodeTimelineTranslator()
  readonly assembler: ReturnType<typeof createProviderTimelineAssembler>
  /** Interaction requests held for the person, by their server request id. */
  readonly pendingPrompts = new Map<string, ZcodeHeldPrompt>()

  constructor(input: {
    events: StructuredAgentSessionEventSink | undefined
    sessionId: string
    generation: string
    providerSessionId: string
  }) {
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
    if (method === 'session/event') {
      const envelope = params as { type?: unknown; seq?: unknown }
      console.info(
        `[zcode-adapter] event type=${String(envelope.type)} seq=${String(envelope.seq)}`
      )
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
      const applied = this.assembler.apply(event)
      if (!('admission' in applied) || !applied.admission.accepted) {
        console.info(
          `[zcode-adapter] timeline refused: ${event.type} ${JSON.stringify(applied).slice(0, 160)}`
        )
      }
    }
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
