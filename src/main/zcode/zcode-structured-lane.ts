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
import { mapZcodeProtocolQuestions } from './zcode-protocol-questions'

const RETRY_MS = 250
/** Refused rounds before a held turn.end is called stuck in the log. */
const STUCK_RETRY_WARN_ROUNDS = 40

/** The tool call an interaction request names, when it names one. */
function toolCallIdOf(params: unknown): string | null {
  const value = (params as { toolCallId?: unknown } | null | undefined)?.toolCallId
  return typeof value === 'string' ? value : null
}
import type { ZcodeAppServerConnection } from './zcode-app-server-connection'

/** What a held interaction request needs to be answered over the transport.
 *  Question texts ride along because the server's answer merge keys the
 *  answers record by the question text, not by any id. */
export type ZcodeHeldPrompt = {
  kind: 'approval' | 'question'
  requestId: number | string
  /** The tool call the interaction belongs to: an unanswered question is
   *  re-asked every few seconds under a fresh interaction and wire id, and
   *  only the newest ask of a tool call stays answerable. */
  toolCallId?: string
  questions?: readonly { id: string; question: string }[]
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
  /** The send's provider item. zcode never echoes the user message as its own
   *  row, so the submission's own identity stands in — the journal's dispatch
   *  alias then maps the id to itself. Naming the turn row here would alias it
   *  to the submission and make the turn-end batch write a stale revision. */
  providerIdentity: {
    provider: 'orca'
    clientMessageId: string
  }
}

export class ZcodeStructuredLane {
  readonly translator = new ZcodeTimelineTranslator((reason, envelope) => {
    if (typeof envelope.type === 'string' && envelope.type.startsWith('turn.')) {
      // A completion the translator cannot shape is a turn that never ends.
      console.warn(
        `[zcode-lane] dropped ${String(envelope.type)} (reason ${reason}, ` +
          `seq=${typeof envelope.seq === 'number' ? envelope.seq : '?'}, session ${this.sessionId})`
      )
    }
  })
  readonly assembler: ReturnType<typeof createProviderTimelineAssembler>
  /** Interaction requests held for the person, by their server request id. */
  readonly pendingPrompts = new Map<string, ZcodeHeldPrompt>()
  /** The highest session/event seq applied; a re-delivered envelope drops. */
  private lastSeq = 0

  /** The resume snapshot's own event position: subscribe replays everything
   *  after it, and the replayed turn.started of the live turn re-opens it,
   *  superseding the running row into a revision conflict. */
  seedSeq(seq: number): void {
    if (seq > this.lastSeq) {
      this.lastSeq = seq
    }
  }
  /** Events the sink refused under backpressure, re-applied until admitted. */
  private readonly retry: ProviderTimelineEvent[] = []
  /** Consecutive refused rounds across retries; reset by any admitted event. */
  private retryRounds = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** The send whose turn has not ended; its dispatch settles when the turn does. */
  private armedSend: string | null = null
  /** The provider turn id the armed send opened into. */
  private armedTurn: string | null = null
  /** A fast turn can start AND end before session/send's reply returns: the
   *  dispatch still in flight needs the identity of the turn that already ran. */
  private settledTurn: string | null = null
  /** The send the settled turn answered, so its provider identity survives the settle. */
  private settledSend: string | null = null

  /** The send's provider identity once a turn opened under it (or already
   *  settled under it, when the whole turn raced the send's reply). */
  armedTurnIdentity(): ZcodeDispatchSettlement['providerIdentity'] | null {
    const turn = this.armedTurn ?? this.settledTurn
    const send = this.armedSend ?? this.settledSend
    if (turn === null || send === null) {
      return null
    }
    return { provider: 'orca', clientMessageId: send }
  }
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
    this.sessionId = input.sessionId
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
      // A delivery mode may batch several envelopes into one notification;
      // each keeps its own seq, guarded exactly like a lone envelope.
      const batch = (params as { events?: unknown[] } | null | undefined)?.events
      if (Array.isArray(batch)) {
        for (const one of batch) {
          this.notification('session/event', one)
        }
        return
      }
      const envelope = params as { type?: unknown; seq?: unknown }
      if (typeof envelope.seq === 'number') {
        if (envelope.seq <= this.lastSeq) {
          if (envelope.type === 'turn.completed' || envelope.type === 'turn.failed') {
            // A completion the seq guard eats leaves the UI spinning — never silently.
            console.warn(
              `[zcode-lane] ${String(envelope.type)} seq=${envelope.seq} eaten by guard lastSeq=${this.lastSeq} session=${this.sessionId}`
            )
          }
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
    this.retireReaskedPrompt('approval', toolCallIdOf(params))
    this.pendingPrompts.set(String(requestId), {
      kind: 'approval',
      requestId,
      ...(toolCallIdOf(params) !== null ? { toolCallId: toolCallIdOf(params) ?? undefined } : {})
    })
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
    const questions = mapZcodeProtocolQuestions(
      (params as { questions?: unknown } | null | undefined)?.questions
    )
    this.retireReaskedPrompt('question', toolCallIdOf(params))
    this.pendingPrompts.set(String(requestId), {
      kind: 'question',
      requestId,
      ...(toolCallIdOf(params) !== null ? { toolCallId: toolCallIdOf(params) ?? undefined } : {}),
      ...(questions.length > 0
        ? { questions: questions.map(({ id, question }) => ({ id, question })) }
        : {})
    })
    this.applyAll(
      this.translator.translate({
        type: 'userInput.requested',
        timestamp: Date.now(),
        payload: params as Record<string, unknown>
      })
    )
  }

  /** An unanswered interaction is re-asked every few seconds under a fresh
   *  interaction and wire id; the older ask of the same tool call is no longer
   *  answerable, so its hold retires here — elimination stays at one. */
  private retireReaskedPrompt(kind: 'approval' | 'question', toolCallId: string | null): void {
    if (toolCallId === null) {
      return
    }
    for (const [key, held] of this.pendingPrompts) {
      if (held.kind === kind && held.toolCallId === toolCallId) {
        this.pendingPrompts.delete(key)
      }
    }
  }

  /** Orca's send reached the provider. */
  inputAccepted(clientMessageId: string, requestedAt: number): void {
    this.armedSend = clientMessageId
    this.settledTurn = null
    this.settledSend = null
    this.assembler.apply({ type: 'input.accepted', clientMessageId, requestedAt })
  }

  /** A dispatched builtin answered without a provider turn (e.g. /goal): its
   *  answer becomes a self-contained completed turn, so the armed send settles
   *  through the ordinary binding instead of waiting on a turn that never opens. */
  commandTurn(response: string, turnId: string): void {
    const at = Date.now()
    this.armedTurn = turnId
    this.applyAll([
      { type: 'turn.open', turn: turnId, at },
      {
        type: 'item.close',
        item: `${turnId}-response`,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: response }]
        }
      },
      { type: 'turn.end', turn: turnId, at: at + 1, state: 'completed', outcome: 'success' }
    ])
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
      // The wire result schema is strict: {decision, reason?}. The card's
      // deny option (and only it) is a denial; allow_once, allow_project and
      // approvals of every other name all read as allow.
      return {
        decision: response.kind === 'option' && response.optionId === 'deny' ? 'deny' : 'allow'
      }
    }
    if (response.kind !== 'answers') {
      return { action: 'decline' }
    }
    // The server merges content.answers keyed by the question TEXT (it derives
    // those keys from the tool input); synthesized card ids map back by order.
    const answers: Record<string, string> = {}
    response.answers.forEach((answer, index) => {
      const question = pending.questions?.[index]?.question
      if (question === undefined) {
        return
      }
      const value = answer.other ?? answer.optionIds.join(', ')
      if (value.length > 0) {
        answers[question] = value
      }
    })
    if (Object.keys(answers).length === 0) {
      return { action: 'decline' }
    }
    return { action: 'accept', content: { answers } }
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
        // A stuck retry is the difference between a busy and a dead chat, so
        // count rounds: a turn.end still refused after many rounds means the
        // row never settles and the UI spins forever — say so, loudly.
        this.retryRounds += 1
        if (event.type === 'turn.end' && this.retryRounds === STUCK_RETRY_WARN_ROUNDS) {
          console.warn(
            `[zcode-lane] turn.end admission refused ${STUCK_RETRY_WARN_ROUNDS} rounds ` +
              `(session ${this.sessionId}, turn ${this.armedTurn ?? event.turn ?? '?'}): ` +
              `the turn may never settle. reason=${JSON.stringify(applied.admission.reason ?? null)}`
          )
        }
        this.retry.push(event)
        this.scheduleRetry()
        continue
      }
      this.retryRounds = 0
      // The dispatch the armed send opened settles with its turn's end: the
      // journal row alone never releases the chat's working state.
      if (
        event.type === 'turn.end' &&
        this.armedSend !== null &&
        this.armedTurn !== null &&
        this.onDispatchSettled !== undefined
      ) {
        this.settledTurn = this.armedTurn
        this.settledSend = this.armedSend
        this.onDispatchSettled({
          sessionId: this.sessionId,
          clientMessageId: this.armedSend,
          providerIdentity: { provider: 'orca', clientMessageId: this.armedSend }
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
