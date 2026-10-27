// The turn surface of a live zcode session: send (with its pre-write opener and
// its refusal words), the `/goal` builtin routed to its protocol method, stop,
// and compaction, as one bounded step each.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
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

/** `/goal` arguments → the protocol's action + objective, live-verified:
 *  `/goal` shows, `pause|resume|clear` act, `replace <obj>` swaps, the rest sets. */
function parseZcodeGoalCommand(
  text: string
):
  | { action: 'show' | 'set' | 'replace' | 'pause' | 'resume' | 'clear'; objective?: string }
  | undefined {
  const match = /^\/goal(?:[ \t]+(.*))?$/u.exec(text.trim())
  if (!match) {
    return undefined
  }
  const rest = (match[1] ?? '').trim()
  if (rest.length === 0) {
    return { action: 'show' }
  }
  const verb = /^(pause|resume|clear)(?:[ \t]+|$)/u.exec(rest)
  if (verb) {
    return { action: verb[1] as 'pause' | 'resume' | 'clear' }
  }
  const replace = /^replace[ \t]+(.+)$/u.exec(rest)
  if (replace) {
    return { action: 'replace', objective: replace[1].trim() }
  }
  return { action: 'set', objective: rest }
}

async function dispatchZcodeGoal(
  session: ZcodeSessionLike,
  clientMessageId: string,
  text: string,
  timeoutMs: number
): Promise<AgentSessionDispatchOutcome | undefined> {
  const goal = parseZcodeGoalCommand(text)
  if (goal === undefined) {
    return undefined
  }
  // The TUI runs /goal as a protocol call, not a model turn; the command's own
  // answer becomes a completed turn so the send binds and settles like any other.
  session.lane.inputAccepted(clientMessageId, Date.now())
  try {
    const result = (await session.connection.request(
      'session/goal',
      {
        sessionId: session.providerSessionId,
        action: goal.action,
        ...(goal.objective !== undefined ? { objective: goal.objective } : {})
      },
      { timeoutMs }
    )) as { response?: unknown }
    const response = typeof result.response === 'string' ? result.response : 'Goal updated.'
    const turnId = `goal-command-${Date.now()}`
    session.lane.commandTurn(response, turnId)
    const identity = session.lane.armedTurnIdentity()
    if (identity !== null) {
      return { state: 'accepted', providerIdentity: identity }
    }
    return { state: 'admitted' }
  } catch (error) {
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
  // The TUI intercepts `/goal` locally; over the protocol the text would reach
  // the model, so the builtin is routed to its method before the write.
  const goal = await dispatchZcodeGoal(session, input.clientMessageId, text, timeoutMs)
  if (goal !== undefined) {
    return goal
  }
  // Accepted before the write: turn.started (and on fast turns, turn.completed)
  // arrive while the send's reply is still in flight, and an opener registered
  // only after the await never binds — the submission stays pending and the
  // chat reads working forever.
  session.lane.inputAccepted(input.clientMessageId, input.requestedAt ?? Date.now())
  try {
    await sendZcodePromptWithBusyRetry(
      session,
      text,
      zcodePromptAttachments(input.body.blocks),
      timeoutMs
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

const SEND_BUSY_RETRY_INTERVAL_MS = 1_000
const SEND_BUSY_RETRY_WINDOW_MS = 30_000

/** `image-ref` blocks → the protocol's prompt attachments (desktop sends images this way; a
 *  prompt without them leaves the model reading only the "[Image #1]" placeholder text). */
export function zcodePromptAttachments(blocks: readonly unknown[]): Record<string, unknown>[] {
  const attachments: Record<string, unknown>[] = []
  for (const block of blocks as NativeChatBlock[]) {
    if (block.type !== 'image-ref') {
      continue
    }
    if (typeof block.path === 'string' && block.path.length > 0) {
      const filename = block.path.split(/[\\/]/).pop() ?? 'pasted.png'
      attachments.push({
        kind: 'image',
        filename,
        mimeType: imageMimeOf(filename),
        localPath: block.path
      })
    } else if (typeof block.url === 'string' && block.url.startsWith('data:')) {
      // Strict shape: the server decodes dataBase64 verbatim, so a non-image or
      // non-base64 data URL must be dropped here, not forwarded to fail there.
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(block.url)
      if (match !== null && match[2].length > 0) {
        attachments.push({
          kind: 'image',
          filename: `pasted.${mimeExtensionOf(match[1].toLowerCase())}`,
          mimeType: match[1].toLowerCase(),
          dataBase64: match[2]
        })
      }
    }
  }
  return attachments
}

function imageMimeOf(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'jpg' || extension === 'jpeg') {
    return 'image/jpeg'
  }
  if (extension === 'webp' || extension === 'gif') {
    return `image/${extension}`
  }
  return 'image/png'
}

function mimeExtensionOf(mimeType: string): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length) || 'png'
}

/** The server's words for a second prompt while its turn is still closing. */
function isPromptStillRunningRefusal(error: unknown): boolean {
  return (
    isZcodeAppServerRequestError(error) &&
    error.message.toLowerCase().includes('prompt is already running')
  )
}

/**
 * `session/send` with a bounded busy-retry. Orca can read a turn as settled
 * (its journal turn-end landed) while the server is still closing that turn —
 * the queue drains into exactly that window. The refusal is a "try again
 * shortly", not the person's answer, so the send backs off and retries inside
 * a bounded window before it surfaces as a rejection.
 */
async function sendZcodePromptWithBusyRetry(
  session: ZcodeSessionLike,
  text: string,
  attachments: Record<string, unknown>[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, SEND_BUSY_RETRY_WINDOW_MS)
  for (;;) {
    try {
      await session.connection.request(
        'session/send',
        {
          sessionId: session.providerSessionId,
          content: text,
          ...(attachments.length > 0 ? { attachments } : {})
        },
        { timeoutMs }
      )
      return
    } catch (error) {
      if (
        !isPromptStillRunningRefusal(error) ||
        Date.now() + SEND_BUSY_RETRY_INTERVAL_MS > deadline
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_BUSY_RETRY_INTERVAL_MS))
    }
  }
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
