// Runtime adapters: real journal DB access, workspace path resolution, and
// zcode availability probe for the roadmap service. These are the dogfood
// wiring replacing the placeholder deps in index.ts.

import { join } from 'node:path'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import Database from '../sqlite/sync-database'
import type { JournalDb } from './journal-row-io'

// ─── Journal DB ─────────────────────────────────────────────────────────

export function openRoadmapJournalDb(_sessionId: string): JournalDb | null {
  const dbPath = join(app.getPath('userData'), 'agent-session-journal.db')
  if (!existsSync(dbPath)) {
    return null
  }
  try {
    const db = new Database(dbPath)
    const query = (sql: string, ...params: unknown[]) => {
      const stmt = db.prepare(sql)
      return {
        all: (...p: unknown[]) =>
          stmt.all(...([...params, ...p] as Parameters<typeof stmt.all>)) as unknown[],
        get: (...p: unknown[]) =>
          stmt.get(...([...params, ...p] as Parameters<typeof stmt.get>)) as unknown
      }
    }
    return { query, close: () => db.close() }
  } catch (e) {
    console.warn(`[roadmap] journal DB open failed: ${e}`)
    return null
  }
}

// ─── Workspace path resolution ──────────────────────────────────────────

export function resolveSessionWorkspaceSync(sessionId: string): string | null {
  const db = openRoadmapJournalDb(sessionId)
  if (!db) {
    return null
  }
  try {
    const row = db
      .query('SELECT workspace_id FROM journal_sessions WHERE session_id = ?')
      .get(sessionId) as { workspace_id: string } | null
    if (!row) {
      return null
    }
    const parts = row.workspace_id.split('::')
    return parts.length > 1 ? (parts[1] ?? null) : null
  } catch {
    return null
  } finally {
    db.close?.()
  }
}

// ─── Session title ──────────────────────────────────────────────────────

export function getSessionTitle(sessionId: string): string {
  const db = openRoadmapJournalDb(sessionId)
  if (!db) {
    return sessionId
  }
  try {
    // zcode sessions: agent_session_records is keyed by journal id; the
    // pipeline passes the native id. Fall back to a LIKE scan on the native id.
    let row = db
      .query('SELECT record_json FROM agent_session_records WHERE session_id = ?')
      .get(sessionId) as { record_json: string } | null
    if (!row) {
      // resolve native -> journal via record chain (records mention the native id)
      const records = db.query('SELECT record_json FROM agent_session_records').all() as {
        record_json: string
      }[]
      row = records.find((r) => r.record_json.includes(sessionId)) ?? null
    }
    if (!row) {
      return sessionId
    }
    const record = JSON.parse(row.record_json) as { conversationName?: string }
    return record.conversationName ?? sessionId
  } catch {
    return sessionId
  } finally {
    db.close?.()
  }
}

// ─── zcode availability ─────────────────────────────────────────────────

let zcodeProbeResult: boolean | null = null

export function probeZcode(): boolean {
  if (zcodeProbeResult !== null) {
    return zcodeProbeResult
  }
  const npmRoot = join(
    process.env.HOME ?? process.env.USERPROFILE ?? '',
    'AppData',
    'Roaming',
    'npm',
    'node_modules'
  )
  zcodeProbeResult =
    process.platform !== 'win32' || existsSync(join(npmRoot, 'zcode-app-cli', 'bin', 'zcode.js'))
  return zcodeProbeResult
}
