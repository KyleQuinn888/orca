// Threshold auto-policy (spec session-enablement v1.3 §1 L2): a session becomes
// eligible for roadmap generation once it shows substantive work. Journal is
// always fully captured; this only decides artifact generation.
//
// Event semantics (spec): a turn = one user message row; a successful edit = a
// tool-call row that writes a file (Edit/Write/apply-patch family or an input
// carrying a file path); reverted edits still count (activity evidence).

import type { ParsedRow } from './journal-row-parse'
import { isMessageRow, isToolCallRow } from './journal-row-parse'
import { type SessionMetrics, recordMetrics } from './roadmap-store'

export const THRESHOLD = {
  distinctFiles: 3,
  edits: 10,
  turns: 10
} as const

const FILE_EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'create_file',
  'edit_file',
  'str_replace_editor',
  'WriteFile',
  'ReplaceFile',
  'rename_file'
])

/** Extract a plausible file path from a tool-call input, or null. */
export function filePathOfInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const candidates = ['file_path', 'filePath', 'path', 'target_file', 'notes']
  for (const key of candidates) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.length > 0) {
      return v
    }
  }
  return null
}

const FILE_EDIT_NAME_HINTS = ['edit', 'write', 'patch', 'create', 'rename', 'replace']
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'list', 'search', 'view', 'cat'])

export function isFileEditRow(row: ParsedRow): boolean {
  if (!isToolCallRow(row)) {
    return false
  }
  const body = row.body as { name?: string; input?: unknown }
  const name = body.name ?? ''
  if (READ_ONLY_TOOLS.has(name)) {
    return false
  }
  if (FILE_EDIT_TOOLS.has(name)) {
    return true
  }
  // unknown tool: an input file path plus an edit-ish name counts; a bare
  // path (Read-style) must not
  const hint = FILE_EDIT_NAME_HINTS.some((h) => name.toLowerCase().includes(h))
  return hint && filePathOfInput(body.input) !== null
}

export function isUserTurnRow(row: ParsedRow): boolean {
  if (!isMessageRow(row)) {
    return false
  }
  return (row.body as { role?: string }).role === 'user'
}

/** Fold journal rows into cumulative metrics (incremental: feed only new rows). */
export function foldRowsIntoMetrics(m: SessionMetrics, rows: ParsedRow[]): void {
  for (const row of rows) {
    if (isUserTurnRow(row)) {
      recordMetrics(m, { turn: true })
    } else if (isFileEditRow(row)) {
      const file = filePathOfInput((row.body as { input?: unknown }).input)
      recordMetrics(m, { edit: true, file })
    }
  }
}

/** Any one criterion suffices (spec: distinct files OR edits OR turns). */
export function crossesThreshold(m: SessionMetrics): boolean {
  return (
    m.fileCount >= THRESHOLD.distinctFiles ||
    m.edits >= THRESHOLD.edits ||
    m.turns >= THRESHOLD.turns
  )
}
