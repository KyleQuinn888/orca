// Journal row I/O for the roadmap service: reads journal rows from the
// session SQLite database and derives chapter-file facts from the workspace.
// Extracted from roadmap-service.ts so the service stays under the line budget.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Cursor } from './roadmap-store'
import type { ChapterCut, JournalRowRef } from './journal-reader'
import { isChapterCardFile } from '../../../roadmap/core/chapter-files'

export type JournalDb = {
  query: (
    sql: string,
    ...params: unknown[]
  ) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown }
  close?: () => void
}

export function readRowsAfterCursor(
  db: JournalDb,
  sessionId: string,
  cursor: Cursor,
  limit = Number.MAX_SAFE_INTEGER
): JournalRowRef[] {
  if (cursor.epoch === '' || cursor.seq === 0) {
    // Read from beginning
    const epochRow = db
      .query('SELECT epoch FROM journal_sessions WHERE session_id = ?')
      .get(sessionId) as { epoch: string } | null
    if (!epochRow) {
      return []
    }
    return readRowsInRange(db, sessionId, epochRow.epoch, 0, Number.MAX_SAFE_INTEGER, limit)
  }
  return readRowsInRange(
    db,
    sessionId,
    cursor.epoch,
    cursor.seq + 1,
    Number.MAX_SAFE_INTEGER,
    limit
  )
}

export function readRowsInRange(
  db: JournalDb,
  sessionId: string,
  epoch: string,
  fromSeq: number,
  toSeq: number,
  limit = Number.MAX_SAFE_INTEGER
): JournalRowRef[] {
  const rawRows = db
    .query(
      'SELECT seq, ts, row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?'
    )
    .all(sessionId, epoch, fromSeq, toSeq, limit) as { seq: number; ts: number; row_json: string }[]
  return rawRows.map((r) => ({
    sessionId,
    epoch,
    seq: r.seq,
    rowJson: r.row_json,
    ts: r.ts
  }))
}

export function countExistingChapters(workspace: string, sessionId: string): number {
  const dir = join(workspace, '.roadmap', '001', sessionId)
  try {
    const names = readdirSync(dir) as string[]
    return names.filter(isChapterCardFile).length
  } catch {
    return 0
  }
}

export function computeUncovered(
  _sessionId: string,
  cut: ChapterCut,
  allRows: JournalRowRef[]
): { fromSeq: number; toSeq: number; note?: string }[] {
  const lastSeq = allRows.at(-1)?.seq ?? cut.toSeq
  if (cut.toSeq >= lastSeq) {
    return []
  }
  return [{ fromSeq: cut.toSeq + 1, toSeq: lastSeq, note: '未闭合章节' }]
}
