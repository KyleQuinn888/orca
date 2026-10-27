// T0.5 PoC: read-only access to Orca journal DBs + zcode TUI sqlite, outside Electron.
// Throwaway gate script — answers: (1) journal locatable across profiles, (2) Bun reads
// rows incl. under WAL while the app may be running, (3) corpus audit journal vs TUI,
// (4) can src/main journal helpers be imported under Bun.
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function readonlyOpen(path: string): Database {
  try {
    return new Database(path, { readonly: true })
  } catch (error) {
    throw new Error(`readonly open failed for ${path}: ${String(error)}`)
  }
}

function auditJournalDb(label: string, path: string): void {
  if (!existsSync(path)) {
    console.log(`${label}: MISSING (${path})`)
    return
  }
  const db = readonlyOpen(path)
  const sessions = db
    .query('SELECT session_id, workspace_id, epoch FROM journal_sessions')
    .all() as { session_id: string; workspace_id: string; epoch: string }[]
  const rowCount = (db.query('SELECT COUNT(*) AS n FROM journal_rows').get() as { n: number }).n
  console.log(`${label}: sessions=${sessions.length} journal_rows=${rowCount}`)
  for (const session of sessions.slice(-3)) {
    console.log(
      `  sample session=${session.session_id} workspace=${session.workspace_id} epoch=${session.epoch}`
    )
  }
  const oneRow = db
    .query('SELECT session_id, epoch, seq, row_json FROM journal_rows ORDER BY ts DESC LIMIT 1')
    .get() as { session_id: string; epoch: string; seq: number; row_json: string } | null
  if (oneRow) {
    const parsed = JSON.parse(oneRow.row_json) as { kind?: string }
    console.log(
      `  latest row: session=${oneRow.session_id.slice(0, 12)}… epoch=${oneRow.epoch} seq=${oneRow.seq} kind=${parsed.kind ?? '?'}`
    )
  }
  db.close()
}

function auditTuiDb(path: string): void {
  if (!existsSync(path)) {
    console.log(`TUI: MISSING (${path})`)
    return
  }
  const db = readonlyOpen(path)
  const tables = (
    db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
  ).map((t) => t.name)
  console.log(`TUI: tables=${tables.join(',')}`)
  for (const candidate of ['session', 'sessions', 'conversation', 'conversations']) {
    if (tables.includes(candidate)) {
      const n = (db.query(`SELECT COUNT(*) AS n FROM ${candidate}`).get() as { n: number }).n
      console.log(`TUI: ${candidate} count=${n}`)
    }
  }
  db.close()
}

const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
console.log('=== Orca journal profiles ===')
auditJournalDb('orca(installed)', join(appData, 'orca', 'agent-session-journal.db'))
auditJournalDb('orca-dev(dev)', join(appData, 'orca-dev', 'agent-session-journal.db'))

console.log('=== zcode TUI sqlite ===')
auditTuiDb(join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'))

console.log('=== src/main import probe (replayJournal under Bun) ===')
try {
  const journalOpen = await import('../src/main/native-chat/agent-session-journal/journal-open.ts')
  console.log(`IMPORT_OK: exports=${Object.keys(journalOpen).slice(0, 6).join(',')}`)
} catch (error) {
  console.log(`IMPORT_FAILED: ${String(error).slice(0, 300)}`)
}
