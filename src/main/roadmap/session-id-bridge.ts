// Session id bridge (roadmap side of the zcode handoff): the roadmap state and
// artifact dirs key by the provider-NATIVE id (stable across structured-session
// resumes); journal rows key by structured ids. Every pipeline entrance
// resolves fresh — journal ids are never cached (spec: lifecycle).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../sqlite/sync-database'
import { decodePersistedAgentSessionProviderHandleChain } from '../../shared/agent-session-provider-handle'
import {
  journalSessionIdsMentioningNativeId,
  resolveJournalSessionsByNativeId
} from './journal-session-resolve'

export type SessionIdScope = {
  /** state/artifact key — provider-native id when known, else the id itself */
  nativeId: string
  /** journal ids carrying this conversation, live head first */
  journalIds: string[]
  workspacePath: string | null
}

/**
 * Interactive surfaces (sessionInfo/setPolicy/deleteSession): fast chain
 * resolution only. An id that is itself a journal id (auto triggers, legacy
 * dogfood data) passes through with itself as the only carrier.
 */
export function scopeFor(
  userDataDir: string,
  sessionId: string,
  fallbackWorkspace: string | null
): SessionIdScope {
  const fast = resolveJournalSessionsByNativeId(userDataDir, sessionId)
  if (fast) {
    return {
      nativeId: sessionId,
      journalIds: fast.journalSessionIds,
      workspacePath: fast.workspacePath
    }
  }
  // journal-domain (or legacy same-id) caller: reverse-resolve the native key
  const native = nativeIdOfJournalSession(userDataDir, sessionId)
  if (native && native !== sessionId) {
    const byNative = resolveJournalSessionsByNativeId(userDataDir, native)
    if (byNative) {
      return {
        nativeId: native,
        journalIds: orderHeadFirst(byNative.journalSessionIds, sessionId),
        workspacePath: byNative.workspacePath
      }
    }
  }
  return {
    nativeId: native ?? sessionId,
    journalIds: [sessionId],
    workspacePath: fallbackWorkspace
  }
}

/**
 * Generation paths (generateNow/backfill): fast chain + exhaustive row scan
 * merged, so content strays whose records retired are not lost.
 * Exhaustive hits are FILTERED BY WORKSPACE: transcript mentions of a session
 * id in OTHER conversations (code snippets, diagnostics) must not pull in
 * 60k+ rows of unrelated content (Codex wiring review #2, confirmed in soak).
 */
export function scopeForGeneration(
  userDataDir: string,
  sessionId: string,
  fallbackWorkspace: string | null
): SessionIdScope {
  const base = scopeFor(userDataDir, sessionId, fallbackWorkspace)
  const exhaustive = journalSessionIdsMentioningNativeId(userDataDir, base.nativeId)
  // Chain-resolved carriers provide the trusted workspace anchor. When the chain
  // resolver returns null (no records mention this native id), the base scope
  // carries the native id itself as carrier — meaningless for workspace lookup.
  // In that case anchor on the FIRST exhaustive hit that has a journal_sessions
  // entry, instead of leaving the anchor null (which excluded ALL exhaustive
  // hits and killed the pipeline with "no ws" — soak day-3).
  let trustedWorkspace = workspaceOfJournalSession(userDataDir, base.journalIds[0] ?? '')
  if (!trustedWorkspace) {
    for (const jid of exhaustive) {
      const ws = workspaceOfJournalSession(userDataDir, jid)
      if (ws) {
        trustedWorkspace = ws
        break
      }
    }
  }
  const merged = [...base.journalIds]
  for (const jid of exhaustive) {
    if (merged.includes(jid)) {
      continue
    }
    const jidWorkspace = workspaceOfJournalSession(userDataDir, jid)
    if (trustedWorkspace && jidWorkspace && jidWorkspace === trustedWorkspace) {
      merged.push(jid)
    }
  }
  return { ...base, journalIds: merged }
}

function workspaceOfJournalSession(userDataDir: string, journalSessionId: string): string | null {
  if (!journalSessionId) {
    return null
  }
  const dbPath = join(userDataDir, 'agent-session-journal.db')
  if (!existsSync(dbPath)) {
    return null
  }
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db
      .prepare('SELECT workspace_id FROM journal_sessions WHERE session_id = ?')
      .get(journalSessionId) as { workspace_id: string } | undefined
    const parts = row?.workspace_id?.split('::')
    return parts && parts.length > 1 ? (parts[1] ?? null) : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

function orderHeadFirst(ids: string[], head: string): string[] {
  const rest = ids.filter((id) => id !== head)
  return [head, ...rest]
}

/**
 * journal id -> provider-native id via the record's chain HEAD. Returns null
 * when the record is absent or its chain carries no proven native id.
 */
export function nativeIdOfJournalSession(
  userDataDir: string,
  journalSessionId: string
): string | null {
  const dbPath = join(userDataDir, 'agent-session-journal.db')
  if (!existsSync(dbPath)) {
    return null
  }
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
      .get(journalSessionId) as { record_json: string } | undefined
    if (!row) {
      return null
    }
    const record = JSON.parse(row.record_json) as {
      sessionId?: string
      providerHandleChain?: unknown
    }
    const chain = decodePersistedAgentSessionProviderHandleChain(record.providerHandleChain)
    const head = chain?.at(-1)
    return head ? (head.handle.nativeId ?? null) : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}
