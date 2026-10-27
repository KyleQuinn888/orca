// Option application for structured sessions: the picker's live write path,
// and Codex's turn-bound option waits in the delivery loop.

import type { AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'
import { performSetOption } from './structured-agent-session-turns-options'
import type { TurnOutcome } from './structured-agent-session-turns'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { structuredAgentSessionChildRan } from './structured-agent-session-ran-options'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

/** With no child running, intent the next start replays; else the running child's own write. Either
 *  is recorded on the chat at `fence` and published. */
export async function writeStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  target: { sessionId: string; fence: number },
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const { sessionId, fence } = target
  const session = context.sessions.get(sessionId)
  const ctx = {
    sessionId,
    fence,
    now: () => context.now(),
    adapter: context.deps.adapter,
    persistOptions: (options: Readonly<Record<string, string>>) =>
      context.deps.store
        .replaceSessionOptions({ sessionId, fence, options, now: context.now() })
        .then(() => undefined),
    publish: () => session && context.publish(sessionId, session.journal)
  }
  const child = session?.child
  // An agent whose protocol carries a live mode change applies the setting at
  // once; every other one records the intent for its next start.
  const livePermissionMode = Boolean(
    context.deps.agents.capabilities(context.deps.store.getRecord(sessionId)?.provider ?? '')
      ?.livePermissionMode
  )
  if (
    (input.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID && !livePermissionMode) ||
    !child ||
    child.phase === 'starting' ||
    child.close !== undefined
  ) {
    return recordStructuredAgentSessionOptionIntent(context.deps, ctx, input)
  }
  // Held where a start is, so a close, a Stop admitted now or quit ends the wait from outside.
  const wait = context.acquireAborts.begin(sessionId)
  try {
    return await performSetOption(ctx, input, wait.signal)
  } finally {
    wait.end()
  }
}

const OPTION_ORDER = ['model', 'effort'] as const

/** Unset message choices inherit child execution values. */
function sameOptions(
  a: AgentSessionExecutionOptions | undefined,
  b: AgentSessionExecutionOptions | undefined,
  ran: Readonly<Record<string, string>> | undefined
): boolean {
  if ((a === undefined) !== (b === undefined)) {
    return false
  }
  return OPTION_ORDER.every((key) => (a?.[key] ?? ran?.[key]) === (b?.[key] ?? ran?.[key]))
}

/** Codex steer has no model/effort parameters; changed choices need a new turn. */
export function waitsForCodexTurnOptions(
  record: Pick<AgentSessionRecord, 'provider'> | null,
  journal: Pick<AgentSessionJournal, 'newestTurn' | 'submissions' | 'itemBody'>,
  next: AgentJournalSubmission,
  child: StructuredAgentSessionProviderChild
): boolean {
  if (record?.provider !== 'codex') {
    return false
  }
  const body = journal.itemBody(agentJournalSubmissionKey(next.clientMessageId))
  if (body?.kind !== 'message' || body.command) {
    return false
  }
  const turn = journal.newestTurn()
  if (turn?.state !== 'running') {
    return false
  }
  const handed = journal.submissions().filter((submission) => submission.handedOverAt !== undefined)
  const opener = handed.find(
    (submission) => agentJournalSubmissionKey(submission.clientMessageId) === turn.userItemId
  )
  const onChild = handed.filter((submission) => submission.fence === child.fence)
  // An unechoed send may own this turn; joining it first would reorder the thread.
  if (!opener && onChild.some((submission) => submission.dispatchState === 'pending')) {
    return true
  }
  const active =
    opener ??
    // Goal continuations have no opener and run on this child's last turn/start choices.
    onChild
      // A send rejected after its turn opened still set the thread's choices.
      .filter((submission) => submission.dispatchState !== 'rejected' || submission.answeredInTurn)
      .reduce<AgentJournalSubmission | undefined>(
        (newest, submission) =>
          newest && (newest.handedOverAt ?? 0) > (submission.handedOverAt ?? 0)
            ? newest
            : submission,
        undefined
      )
  const ran = structuredAgentSessionChildRan(child)
  if (active) {
    return !sameOptions(active.options, next.options, ran)
  }
  return OPTION_ORDER.some(
    (key) => next.options?.[key] !== undefined && next.options[key] !== ran?.[key]
  )
}
