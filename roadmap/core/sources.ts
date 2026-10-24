// Source DB location: Orca journal (two profiles) + zcode TUI sqlite.
// Outside Electron, %APPDATA% discovery is the only rope — fail loudly
// on missing / locked / corrupt so silent empty runs are impossible.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Database } from 'bun:sqlite'

export type ProfileName = 'orca' | 'orca-dev'

export type LocatedSource =
  | { kind: 'tui'; path: string }
  | { kind: 'journal'; path: string; profile: ProfileName }

export class SourceLocationError extends Error {
  constructor(
    readonly state: 'missing' | 'locked' | 'corrupt',
    message: string
  ) {
    super(message)
    this.name = 'SourceLocationError'
  }
}

export function appDataDir(): string {
  return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
}

export function journalPaths(): { profile: ProfileName; path: string }[] {
  return (['orca', 'orca-dev'] as const).map((profile) => ({
    profile,
    path: join(appDataDir(), profile, 'agent-session-journal.db')
  }))
}

export function tuiPath(): string {
  return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
}

export function locateSource(selector: {
  source?: 'tui' | 'journal'
  profile?: ProfileName
}): LocatedSource {
  if (selector.source === 'tui') {
    if (!existsSync(tuiPath())) {
      throw new SourceLocationError('missing', `zcode TUI database not found at ${tuiPath()}`)
    }
    return { kind: 'tui', path: tuiPath() }
  }
  const candidates = selector.profile
    ? journalPaths().filter((p) => p.profile === selector.profile)
    : journalPaths().filter((p) => existsSync(p.path))
  if (candidates.length === 0) {
    throw new SourceLocationError(
      'missing',
      `no Orca journal database under ${appDataDir()} (profiles orca / orca-dev); pass --source tui for TUI sessions`
    )
  }
  if (candidates.length > 1 && !selector.profile) {
    const sessions = candidates.map((c) => `${c.profile}: ${countJournalSessions(c.path)}`)
    throw new SourceLocationError(
      'missing',
      `multiple Orca profiles found — pass --profile orca or --profile orca-dev (${sessions.join('; ')})`
    )
  }
  const chosen = candidates[0]
  openReadonlyProbe(chosen.path)
  return { kind: 'journal', path: chosen.path, profile: chosen.profile }
}

export function openTui(): { db: Database; path: string } {
  const path = tuiPath()
  if (!existsSync(path)) {
    throw new SourceLocationError('missing', `zcode TUI database not found at ${path}`)
  }
  openReadonlyProbe(path)
  return { db: new Database(path, { readonly: true }), path }
}

function openReadonlyProbe(path: string): void {
  try {
    const db = new Database(path, { readonly: true })
    db.query('SELECT 1').get()
    db.close()
  } catch (error) {
    const message = String(error)
    if (message.includes('SQLITE_BUSY') || message.includes('locked')) {
      throw new SourceLocationError(
        'locked',
        `database is locked (app holding exclusive lock?): ${path}`
      )
    }
    throw new SourceLocationError('corrupt', `database failed read probe at ${path}: ${message}`)
  }
}

function countJournalSessions(path: string): number {
  try {
    const db = new Database(path, { readonly: true })
    const n = (db.query('SELECT COUNT(*) AS n FROM journal_sessions').get() as { n: number }).n
    db.close()
    return n
  } catch {
    return -1
  }
}

export function fileSignature(path: string): string {
  const stats = statSync(path)
  return `${stats.size}b@${stats.mtimeMs}`
}
