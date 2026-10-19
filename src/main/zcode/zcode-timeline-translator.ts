// ZCode session/event envelopes → ProviderTimelineEvent grammar.
//
// Pure: no sink, no journal, no state beyond what one stream's own order gives.
// Payload shapes live-verified against `zcode app-server` 0.16.9 (recorded in
// __fixtures__/zcode-tool-turn.jsonl); the grammar layer owns every journal rule.
//
// Facts this rests on:
// - The event type rides at params.type; payload carries the body.
// - Assistant text arrives only as model.streaming deltas (text_delta /
//   reasoning_delta); message.upserted never rides the live stream.
// - turn.completed.payload.response is the provider's own final reply text, so
//   it closes the turn's last streamed assistant item even if deltas dropped.
// - tool.updated merges by toolCallId: `scheduled` carries the name, the result
//   frame carries success/content, and the input JSON streamed earlier as
//   model.streaming tool_input deltas.

import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { AgentJournalBoundedPayload } from '../../shared/agent-session-journal-types'

/** One session/event envelope as the transport delivers it. */
export type ZcodeSessionEventEnvelope = {
  type?: unknown
  payload?: unknown
  turnId?: unknown
  seq?: unknown
  timestamp?: unknown
}

type ZcodeStreamingPayload = {
  assistantMessageId?: unknown
  delta?: unknown
  kind?: unknown
  toolCallId?: unknown
  toolName?: unknown
  input?: unknown
}

type ZcodeToolPayload = {
  toolCallId?: unknown
  toolName?: unknown
  kind?: unknown
  result?: { success?: unknown; content?: unknown } | null
}

type ZcodeTurnEndPayload = { response?: unknown; resultType?: unknown; duration?: unknown }

const STREAMING_TEXT_KINDS = new Set(['text_delta', 'reasoning_delta'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** Bounded output for a tool result, as the journal's payload bounds spell it. */
function boundedOutput(content: unknown): AgentJournalBoundedPayload | undefined {
  if (content === undefined || content === null) {
    return undefined
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return boundPayload(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
}

/**
 * Translates one envelope; the same envelope twice yields the same events, so a
 * refused admission can retry by re-applying. Streaming tool inputs accumulate
 * across a stream, which is the one piece of cross-envelope state the ZCode
 * protocol forces onto this layer (tool.updated never restates its input).
 */
export class ZcodeTimelineTranslator {
  private readonly toolInputs = new Map<string, string>()
  /** tool.updated frames a call without a result repeatedly (scheduled, started):
   *  the first opens the row, the rest update it. */
  private readonly openedTools = new Set<string>()
  /** The result frame omits the name its earlier frames carried. */
  private readonly toolNames = new Map<string, string>()
  /** The last assistantMessageId that streamed text, per turn: turn.completed's
   *  response closes it, or an anonymous stream when nothing streamed. */
  private readonly lastStreamedByTurn = new Map<string, string>()

  constructor(
    private readonly onDrop?: (reason: string, envelope: ZcodeSessionEventEnvelope) => void
  ) {}

  translate(envelope: ZcodeSessionEventEnvelope): ProviderTimelineEvent[] {
    const type = asString(envelope.type)
    const payload = asRecord(envelope.payload) ?? {}
    const turnId = asString(envelope.turnId)
    const at = asNumber(envelope.timestamp) ?? 0
    const join = turnId === null ? {} : { join: { turn: turnId } }
    switch (type) {
      case null:
        this.onDrop?.('untyped', envelope)
        return []
      case 'turn.started':
        return [{ type: 'turn.open', ...(turnId === null ? {} : { turn: turnId }), at }]
      case 'model.streaming':
        return this.translateStreaming(payload, turnId, join)
      case 'tool.updated':
        return this.translateTool(payload, join)
      case 'turn.completed':
        return this.translateTurnEnd(payload, turnId, at, 'completed', join)
      case 'turn.failed':
        return this.translateTurnEnd(payload, turnId, at, 'interrupted', join)
      case 'permission.requested':
        return this.translatePermissionRequested(payload, join)
      case 'userInput.requested':
        return this.translateUserInputRequested(payload, join)
      default:
        // session.updated carries hook descriptors, streamRecovery carries
        // anchors: journal-worthy neither, and an untyped envelope more so.
        this.onDrop?.(typeof type === 'string' ? type : 'untyped', envelope)
        return []
    }
  }

  private translateStreaming(
    payload: Record<string, unknown>,
    turnId: string | null,
    join: { join?: { turn: string } }
  ): ProviderTimelineEvent[] {
    const streaming = payload as unknown as ZcodeStreamingPayload
    const kind = asString(streaming.kind)
    const assistantMessageId = asString(streaming.assistantMessageId)
    console.info(
      `[zcode-adapter] streaming kind=${String(kind)} id=${String(assistantMessageId)} delta=${String(streaming.delta).slice(0, 30)}`
    )
    if (kind !== null && STREAMING_TEXT_KINDS.has(kind) && assistantMessageId !== null) {
      if (turnId !== null && kind === 'text_delta') {
        this.lastStreamedByTurn.set(turnId, assistantMessageId)
      }
      // Reasoning and reply stream under ONE provider message id; the timeline
      // keys rows by item id, so the reasoning channel takes its own derived id
      // or the two merge into one thinking block that never reads as the reply.
      const channel = kind === 'text_delta' ? 'assistant' : 'reasoning'
      const itemId =
        channel === 'assistant' ? assistantMessageId : `${assistantMessageId}-reasoning`
      return [
        {
          type: 'text.delta',
          item: { id: itemId },
          channel,
          text: asString(streaming.delta) ?? '',
          ...join
        }
      ]
    }
    const toolCallId = asString(streaming.toolCallId)
    if (toolCallId !== null && (kind === 'tool_input_delta' || kind === 'tool_call')) {
      const text =
        kind === 'tool_call'
          ? JSON.stringify(streaming.input ?? {})
          : (asString(streaming.delta) ?? '')
      this.toolInputs.set(toolCallId, text)
      return []
    }
    return []
  }

  private translateTool(
    payload: Record<string, unknown>,
    join: { join?: { turn: string } }
  ): ProviderTimelineEvent[] {
    const tool = payload as unknown as ZcodeToolPayload
    const toolCallId = asString(tool.toolCallId)
    if (toolCallId === null) {
      // The batch frame summarizes calls the per-call frames already covered.
      return []
    }
    const toolName = asString(tool.toolName) ?? this.toolNames.get(toolCallId) ?? 'unknown tool'
    if (asString(tool.toolName) !== null) {
      this.toolNames.set(toolCallId, toolName)
    }
    const input = parseJsonOrKeep(this.toolInputs.get(toolCallId))
    if (tool.result) {
      this.openedTools.delete(toolCallId)
      const success = tool.result.success === true
      return [
        {
          type: 'item.close',
          item: toolCallId,
          body: {
            kind: 'tool-call',
            name: toolName,
            input,
            state: success ? 'completed' : 'failed',
            ...(boundedOutput(tool.result.content) !== undefined
              ? { output: boundedOutput(tool.result.content) }
              : {})
          },
          ...join
        }
      ]
    }
    const body = {
      kind: 'tool-call' as const,
      name: toolName,
      input,
      state: 'running' as const
    }
    if (this.openedTools.has(toolCallId)) {
      return [{ type: 'item.update', item: toolCallId, body, ...join }]
    }
    this.openedTools.add(toolCallId)
    return [{ type: 'item.open', item: toolCallId, body, ...join }]
  }

  private translateTurnEnd(
    payload: Record<string, unknown>,
    turnId: string | null,
    at: number,
    state: 'completed' | 'interrupted',
    join: { join?: { turn: string } }
  ): ProviderTimelineEvent[] {
    const end = payload as unknown as ZcodeTurnEndPayload
    const events: ProviderTimelineEvent[] = []
    console.info(
      `[zcode-adapter] turn end state=${state} response=${String(end.response).slice(0, 40)} resultType=${String(end.resultType)}`
    )
    const response = asString(end.response)
    const turnKey = turnId ?? ''
    if (state === 'completed' && response !== null) {
      const streamed = this.lastStreamedByTurn.get(turnKey)
      if (streamed !== undefined) {
        events.push({ type: 'text.close', item: { id: streamed }, text: response, ...join })
      } else {
        events.push({
          type: 'text.delta',
          item: { stream: `turn:${turnKey}:response` },
          channel: 'assistant',
          text: response,
          ...join
        })
      }
    }
    events.push({
      type: 'turn.end',
      ...(turnId === null ? {} : { turn: turnId }),
      at,
      state,
      ...(state === 'completed'
        ? { outcome: end.resultType === 'success' ? ('success' as const) : ('failure' as const) }
        : { outcome: 'failure' as const }),
      ...(asNumber(end.duration) !== null ? { durationMs: asNumber(end.duration)! } : {})
    })
    return events
  }

  private translatePermissionRequested(
    payload: Record<string, unknown>,
    join: { join?: { turn: string } }
  ): ProviderTimelineEvent[] {
    const requestId = asString(payload.requestId)
    if (requestId === null) {
      return []
    }
    const toolName = asString(payload.toolName) ?? 'tool'
    const options = Array.isArray(payload.options)
      ? payload.options
          .map((option) => asRecord(option))
          .filter((option): option is Record<string, unknown> => option !== null)
          .map((option) => ({
            id: asString(option.optionId) ?? '',
            label: asString(option.name) ?? asString(option.optionId) ?? '',
            ...(asString(option.description) !== null
              ? { description: asString(option.description)! }
              : {})
          }))
      : []
    return [
      {
        type: 'request.open',
        request: requestId,
        body: {
          kind: 'approval',
          title: asString(payload.reason) ?? `Run ${toolName}?`,
          detail: asString(payload.reason),
          options:
            options.length > 0
              ? options
              : [
                  { id: 'allow', label: 'Allow' },
                  { id: 'deny', label: 'Deny' }
                ],
          resolution: {
            state: 'pending' as const,
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        ...join
      }
    ]
  }

  private translateUserInputRequested(
    payload: Record<string, unknown>,
    join: { join?: { turn: string } }
  ): ProviderTimelineEvent[] {
    const requestId = asString(payload.requestId)
    if (requestId === null) {
      return []
    }
    const questions = Array.isArray(payload.questions) ? payload.questions : []
    return [
      {
        type: 'request.open',
        request: requestId,
        body: {
          kind: 'question',
          question: asString(payload.prompt) ?? 'The agent asked a question.',
          ...(questions.length > 0 ? { questions: questions as never } : {}),
          options: [{ id: 'answer', label: 'Answer' }],
          resolution: {
            state: 'pending' as const,
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        ...join
      }
    ]
  }
}

function parseJsonOrKeep(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
