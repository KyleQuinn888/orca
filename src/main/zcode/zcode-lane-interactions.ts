// The lane's held-interaction surface: permission and user-input requests the
// server pushes become answerable cards. A mixin so the lane file stays inside
// its line budget while the state stays one object.

import type { ZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeTimelineTranslator } from './zcode-timeline-translator'
import { mapZcodeProtocolQuestions } from './zcode-protocol-questions'
import { zcodeLaneAnswerFor } from './zcode-lane-answers'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'

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

/** The tool call an interaction request names, when it names one. */
function toolCallIdOf(params: unknown): string | null {
  const value = (params as { toolCallId?: unknown } | null | undefined)?.toolCallId
  return typeof value === 'string' ? value : null
}

export abstract class ZcodeLaneInteractions {
  protected abstract readonly translator: ZcodeTimelineTranslator
  /** Interaction requests held for the person, by their server request id. */
  readonly pendingPrompts = new Map<string, ZcodeHeldPrompt>()

  protected abstract applyAll(events: readonly ProviderTimelineEvent[]): void

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

  /** The protocol answer for the one held request, built from what the person chose. */
  answerFor = zcodeLaneAnswerFor

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
}
