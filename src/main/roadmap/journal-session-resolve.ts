// Resolve the session id a history surface names to the journal session id the
// structured host keys rows under. History UIs pass the provider-NATIVE id
// (zcode's sess_*, Claude's session id, Codex's thread id); the journal keys
// rows by the structured session id, and the only persisted join is each
// record's provider handle chain (agent_session_records.record_json).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../sqlite/sync-database'
import { decodePersistedAgentSessionProviderHandleChain } from '../../shared/agent-session-provider-handle'

export type JournalSessionResolution = {
  /** The live continuation: its record's chain HEAD carries the native id. */
  journalSessionId: string
  /**
   * Every journal session whose record chain mentions the native id, the live
   * continuation first. A fork keeps the seeded id in its chain, and a record
   * that resumed an older conversation spans ids — metrics that want the whole
   * conversation read the list, single-session views read the head field.
   */
  journalSessionIds: string[]
  workspacePath: string | null
}

/**
 * One provider-native session id → the journal sessions that carried it.
 * Provider-neutral: any agent whose native id differs from its journal id
 * (zcode today) resolves through the same chain field. Returns null when no
 * record mentions the id — callers treat that as "awaiting session mapping",
 * never as an empty journal.
 *
 * Lifecycle semantics: the journal id is stable while one structured session
 * runs, and a NEW structured session that resumes the same provider
 * conversation gets a NEW journal id (its record chain links back to the
 * native id). The list therefore has one entry per record that ever carried
 * the conversation; the head field always names the live one.
 */
export function resolveJournalSessionsByNativeId(
  userDataDir: string,
  nativeSessionId: string
): JournalSessionResolution | null {
  if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) {
    return null
  }
  const dbPath = join(userDataDir, 'agent-session-journal.db')
  if (!existsSync(dbPath)) {
    return null
  }
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    // The LIKE only prefilters; the decoded chain decides. Escape LIKE
    // metacharacters so an id containing % or _ cannot widen the scan.
    const escaped = nativeSessionId.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    const rows = db
      .prepare(
        "SELECT rowid AS rid, session_id, record_json FROM agent_session_records WHERE record_json LIKE ? ESCAPE '\\'"
      )
      .all(`%${escaped}%`) as { rid: number; session_id: string; record_json: string }[]
    const headMatches: { sessionId: string; recency: number; rid: number }[] = []
    const tailMatches: { sessionId: string; recency: number; rid: number }[] = []
    for (const row of rows) {
      let chain: ReturnType<typeof decodePersistedAgentSessionProviderHandleChain> = null
      try {
        chain = decodePersistedAgentSessionProviderHandleChain(
          (JSON.parse(row.record_json) as { providerHandleChain?: unknown }).providerHandleChain
        )
      } catch {
        continue
      }
      if (chain === null) {
        continue
      }
      // The matching links' latest observation ranks carriers by recency; the
      // rowid breaks ties identical chains cannot (a newest record is the live
      // continuation — resumes append, they do not reorder).
      const matching = chain.filter((link) => link.handle.nativeId === nativeSessionId)
      if (matching.length === 0) {
        continue
      }
      const recency = Math.max(...matching.map((link) => link.observedAt))
      const entry = { sessionId: row.session_id, recency, rid: row.rid }
      // A resume appends a link per process restart, so the head is the live
      // continuation; older links belong to superseded sessions.
      if (chain.at(-1)?.handle.nativeId === nativeSessionId) {
        headMatches.push(entry)
      } else {
        tailMatches.push(entry)
      }
    }
    if (headMatches.length === 0 && tailMatches.length === 0) {
      return null
    }
    const byNewest = (
      a: { recency: number; rid: number },
      b: { recency: number; rid: number }
    ): number => b.recency - a.recency || b.rid - a.rid
    const journalSessionIds = [
      ...headMatches.sort(byNewest).map((entry) => entry.sessionId),
      ...tailMatches.sort(byNewest).map((entry) => entry.sessionId)
    ]
    const journalSessionId = journalSessionIds[0] as string
    const session = db
      .prepare('SELECT workspace_id FROM journal_sessions WHERE session_id = ?')
      .get(journalSessionId) as { workspace_id: string } | undefined
    return {
      journalSessionId,
      journalSessionIds,
      workspacePath: workspacePathOf(session?.workspace_id)
    }
  } catch (error) {
    console.warn('[roadmap] journal session resolve failed:', error)
    return null
  } finally {
    db?.close()
  }
}

/** journal_sessions.workspace_id is `<workspace uuid>::<path>`. */
function workspacePathOf(workspaceId: string | undefined): string | null {
  if (typeof workspaceId !== 'string') {
    return null
  }
  const parts = workspaceId.split('::')
  return parts.length > 1 ? (parts[1] ?? null) : null
}

/**
 * Every journal session whose ROWS mention the native id — the exhaustive
 * counterpart to the chain scan. Rows embed the provider session id in their
 * payloads (60,630 of 60,646 rows in a production conversation), so this also
 * finds sessions whose record retired or whose chain never proved the id
 * (content-bearing strays the fast path cannot reach). Costs one full-table
 * LIKE: ~1.2s on a 105k-row production journal, so call it on generation
 * paths, not per keystroke; interactive surfaces use the chain resolver.
 */
export function journalSessionIdsMentioningNativeId(
  userDataDir: string,
  nativeSessionId: string
): string[] {
  if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) {
    return []
  }
  const dbPath = join(userDataDir, 'agent-session-journal.db')
  if (!existsSync(dbPath)) {
    return []
  }
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const escaped = nativeSessionId.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    const rows = db
      .prepare("SELECT DISTINCT session_id FROM journal_rows WHERE row_json LIKE ? ESCAPE '\\'")
      .all(`%${escaped}%`) as { session_id: string }[]
    return rows.map((row) => row.session_id)
  } catch (error) {
    console.warn('[roadmap] journal session row scan failed:', error)
    return []
  } finally {
    db?.close()
  }
}
