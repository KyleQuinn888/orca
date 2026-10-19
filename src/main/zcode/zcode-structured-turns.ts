// The turn surface of a live zcode session: send (with its pre-write opener and
// its refusal words), stop, and compaction, as one bounded step each.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { isZcodeAppServerRequestError } from './zcode-app-server-session'
import type { ZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeStructuredLane } from './zcode-structured-lane'

/** What the turn surface needs from a live session. */
export type ZcodeSessionLike = {
  providerSessionId: string
  connection: ZcodeAppServerConnection
  lane: ZcodeStructuredLane
}

export async function dispatchZcodeTurn(
  session: ZcodeSessionLike,
  input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  },
  timeoutMs: number
): Promise<AgentSessionDispatchOutcome> {
  await input.beforeDispatch?.()
  const text = input.body.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  // Accepted before the write: turn.started (and on fast turns, turn.completed)
  // arrive while the send's reply is still in flight, and an opener registered
  // only after the await never binds — the submission stays pending and the
  // chat reads working forever.
  session.lane.inputAccepted(input.clientMessageId, input.requestedAt ?? Date.now())
  try {
    await session.connection.request(
      'session/send',
      { sessionId: session.providerSessionId, content: text },
      { timeoutMs }
    )
  } catch (error) {
    // The provider refused its own answer: words for the person, never a retry.
    if (isZcodeAppServerRequestError(error)) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) }),
          { surface: 'rejection', agentName: 'ZCode' }
        )
      }
    }
    throw error
  }
  // turn.started arrives while the send's reply is in flight (the record reader
  // delivers it first), so the turn the send opened is usually known here: an
  // accepted dispatch with its identity settles the submission through the same
  // journal path codex's turn/start answer takes. Falls back to admitted.
  const armedTurnIdentity = session.lane.armedTurnIdentity()
  if (armedTurnIdentity !== null) {
    return { state: 'accepted', providerIdentity: armedTurnIdentity }
  }
  return { state: 'admitted' }
}

export async function compactZcodeTurn(
  session: ZcodeSessionLike,
  timeoutMs: number
): Promise<{ state: 'accepted'; providerIdentity: null }> {
  await session.connection.request(
    'session/compact',
    { sessionId: session.providerSessionId },
    { timeoutMs }
  )
  return { state: 'accepted', providerIdentity: null }
}

export async function cancelZcodeTurn(session: ZcodeSessionLike): Promise<{ cancelled: boolean }> {
  await session.connection.request('session/stop', { sessionId: session.providerSessionId })
  return { cancelled: true }
}
