// One zcode child's timeline: protocol events in, journal rows out, held
// interaction requests as the cards a person answers.
//
// The adapter owns the child and the session API; this lane owns everything a
// turn renders: the translator maps ZCode envelopes to the shared provider
// grammar, the assembler turns that grammar into journal writes through the
// sink, and held permission/user-input requests stay answerable until the
// person (or the child's death) settles them.

import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { createProviderTimelineAssembler } from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'
import { ZcodeLaneInteractions, type ZcodeHeldPrompt } from './zcode-lane-interactions'

export type { ZcodeHeldPrompt }

const RETRY_MS = 250
/** Refused rounds before a held turn.end is called stuck in the log. */
const STUCK_RETRY_WARN_ROUNDS = 40

/** Lane diagnostics reach the host's trace file; without a logger, console. */
type LaneDiagnosticsLogger = Pick<StructuredAgentSessionLogger, 'warn'>

/** An event sink with no journal behind it: the protocol still runs, the timeline drops. */
const NO_TIMELINE_EVENT_SINK = {
  tryAppendTransition: () => ({ accepted: false, reason: 'no-sink' }),
  // The decisions guard a null journal ('absent'); an array here would reach
  // them truthy and crash on itemBody the first turn event.
  journalItems: () => null,
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

export class ZcodeStructuredLane extends ZcodeLaneInteractions {
  /** Diagnostics a packaged desktop can still see; console.warn goes nowhere there. */
  private readonly logger: LaneDiagnosticsLogger | undefined

  constructor(
    private readonly onDispatchSettled: ((settlement: ZcodeDispatchSettlement) => void) | undefined,
    input: {
      events: StructuredAgentSessionEventSink | undefined
      sessionId: string
      generation: string
      providerSessionId: string
      logger?: LaneDiagnosticsLogger
    }
  ) {
    super()
    this.sessionId = input.sessionId
    this.logger = input.logger
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
  readonly translator = new ZcodeTimelineTranslator((reason, envelope) => {
    if (typeof envelope.type === 'string' && envelope.type.startsWith('turn.')) {
      // A completion the translator cannot shape is a turn that never ends.
      this.diagnose(`dropped ${String(envelope.type)}`, {
        reason,
        seq: typeof envelope.seq === 'number' ? envelope.seq : undefined
      })
    }
  })
  readonly assembler: ReturnType<typeof createProviderTimelineAssembler>
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

  /** One lane diagnostic, named for log search: ndjson when a logger was wired,
   *  console for tests and the unpackaged dev runs. */
  private diagnose(message: string, fields: Record<string, unknown>): void {
    // A diagnostic must never fail the event path it reports on: by the time a
    // logger throws, lastSeq has advanced and the event would be lost for good.
    try {
      const entry = { scope: 'zcode-lane', sessionId: this.sessionId, ...fields }
      if (this.logger !== undefined) {
        this.logger.warn(message, entry)
      } else {
        console.warn(`[zcode-lane] ${message}`, JSON.stringify(entry))
      }
    } catch {
      // The lane's own diagnostics are best-effort by contract.
    }
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
            this.diagnose(`${String(envelope.type)} eaten by seq guard`, {
              seq: envelope.seq,
              lastSeq: this.lastSeq
            })
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

  /** The person stopped the armed turn. The provider may leave it unterminated
   *  on the wire — its session then also refuses the next prompt as already
   *  running — so the accepted stop settles the turn here: the journal row must
   *  not keep spinning and the armed dispatch must release the working state. */
  interruptArmedTurn(): void {
    const turn = this.armedTurn ?? this.settledTurn
    if (this.armedSend === null || turn === null) {
      return
    }
    this.applyAll([{ type: 'turn.end', turn, at: Date.now(), state: 'interrupted' }])
  }

  /** The child is gone: settle the timeline after everything it said lands. */
  sessionEnded(): void {
    this.pendingPrompts.clear()
    this.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
  }

  protected applyAll(events: readonly ProviderTimelineEvent[]): void {
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
          this.diagnose(
            `turn.end admission refused ${STUCK_RETRY_WARN_ROUNDS} rounds — the turn may never settle`,
            {
              turn: this.armedTurn ?? event.turn ?? null,
              reason: applied.admission.reason ?? null
            }
          )
        }
        this.retry.push(event)
        this.scheduleRetry()
        continue
      }
      this.retryRounds = 0
      // An admitted event can still be dropped by the decision layer (no plan, no
      // write) — e.g. a turn.end with 'no-turn'/'turn-unknown' settles the dispatch
      // below while the turn row stays running forever. That silent path is what
      // the spinner looked like for weeks: report it by rule name.
      if (
        (event.type === 'turn.end' || event.type === 'turn.open') &&
        applied.dropped !== undefined
      ) {
        this.diagnose(`${event.type} dropped by decision rule '${applied.dropped}'`, {
          turn: event.turn ?? null,
          open: this.armedTurn ?? null
        })
      }
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
