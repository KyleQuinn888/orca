// TUI session reader: transcript projection, human-message counting (S2),
// chapter windowing, and digest construction for the summarizer.

import type { Database } from 'bun:sqlite'

export type TuiMessage = {
  id: string
  seq: number
  timeCreated: number
  role: string
  human: boolean
  texts: string[]
}

export type TuiSession = {
  id: string
  title: string
  directory: string
  timeCreated: number
  timeUpdated: number
  messages: TuiMessage[]
}

// System injections the TUI records under the user role; they must not
// count toward chapter boundaries (S2: 43% of user-role rows in the
// baseline window were injections).
const INJECTION_MARKERS = [
  'The TodoWrite tool hasn\u2019t been used',
  "The TodoWrite tool hasn't been used",
  '<task-notification>',
  '<system-reminder>',
  '[SYSTEM]',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>'
]

export function isHumanUserMessage(texts: string[]): boolean {
  const joined = texts.join('\n').slice(0, 4000)
  return !INJECTION_MARKERS.some((marker) => joined.includes(marker))
}

export function readTuiSession(db: Database, sessionId: string): TuiSession {
  const session = db
    .query('SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ?')
    .get(sessionId) as
    | { id: string; title: string; directory: string; time_created: number; time_updated: number }
    | undefined
  if (!session) {
    throw new Error(`session not found in TUI database: ${sessionId}`)
  }
  const messages = (
    db
      .query(
        `SELECT m.id, m.sequence, m.time_created, m.data, (
           SELECT group_concat(json_extract(p.data, '$.text'), char(10))
           FROM part p
           WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text'
         ) AS texts
         FROM message m WHERE m.session_id = ? ORDER BY m.sequence`
      )
      .all(sessionId) as {
      id: string
      sequence: number
      time_created: number
      data: string
      texts: string | null
    }[]
  ).map((row) => {
    const data = JSON.parse(row.data) as { role?: string }
    const texts = row.texts ? row.texts.split('\n') : []
    const role = data.role ?? 'unknown'
    return {
      id: row.id,
      seq: row.sequence,
      timeCreated: row.time_created,
      role,
      human: role === 'user' ? isHumanUserMessage(texts) : false,
      texts
    }
  })
  return {
    id: session.id,
    title: session.title ?? session.id,
    directory: session.directory ?? '',
    timeCreated: session.time_created,
    timeUpdated: session.time_updated,
    messages
  }
}

export type ChapterWindow = {
  index: number
  firstMsgSeq: number
  lastMsgSeq: number
  userMsg: { human: number; total: number }
  firstTime: string
  lastTime: string
  durationMin: number
}

/** Windows of 15-30 human messages; boundaries only between chapters. */
export function proposeChapterWindows(
  session: TuiSession,
  options: { targetHuman?: number } = {}
): ChapterWindow[] {
  const target = options.targetHuman ?? 20
  const humanRows = session.messages.filter((m) => m.human)
  const windows: ChapterWindow[] = []
  let start = 0
  for (let i = target; ; i += target) {
    if (i >= humanRows.length) {
      const remaining = humanRows.length - start
      if (remaining >= Math.ceil(target / 2) || windows.length === 0) {
        pushWindow(humanRows, start, humanRows.length - 1, windows)
      } else if (remaining > 0 && windows.length > 0) {
        pushWindow(humanRows, start, humanRows.length - 1, windows)
      }
      break
    }
    pushWindow(humanRows, start, i - 1, windows)
    start = i
  }
  return windows
}

function pushWindow(rows: TuiMessage[], from: number, to: number, windows: ChapterWindow[]): void {
  if (to < from) {
    return
  }
  const first = rows[from]
  const last = rows[to]
  const userMsg = { human: to - from + 1, total: 0 }
  windows.push({
    index: windows.length + 1,
    firstMsgSeq: first.seq,
    lastMsgSeq: last.seq,
    userMsg,
    firstTime: new Date(first.timeCreated).toISOString(),
    lastTime: new Date(last.timeCreated).toISOString(),
    durationMin: Math.round((last.timeCreated - first.timeCreated) / 60000)
  })
}

/**
 * Digest for one window: human messages in full, assistant turns trimmed,
 * tool activity as name-only lines. Bounded by maxChars; when clipped the
 * uncovered marker names the dropped range (S0-adjacent honesty rule).
 */
export function buildDigest(
  session: TuiSession,
  window: ChapterWindow,
  options: { maxChars?: number } = {}
): { digest: string; truncated: boolean } {
  const maxChars = options.maxChars ?? 24_000
  const lines: string[] = [
    `会话：${session.title}（${session.id}）`,
    `章节区间：seq ${window.firstMsgSeq}–${window.lastMsgSeq}（人工消息 ${window.userMsg.human} 条）`
  ]
  let truncated = false
  let budget = maxChars
  const inWindow = session.messages.filter(
    (m) => m.seq >= window.firstMsgSeq && m.seq <= window.lastMsgSeq
  )
  for (const message of inWindow) {
    const isHuman = message.human
    const isUserRole = message.role === 'user'
    let block: string
    if (isHuman) {
      block = `[用户 seq ${message.seq}] ${message.texts.join('\n').slice(0, 4000)}`
    } else if (isUserRole) {
      continue // system injection: skip entirely
    } else {
      const text = message.texts.join('\n')
      block = `[${message.role} seq ${message.seq}] ${text.length > 800 ? `${text.slice(0, 800)}…(截断)` : text}`
    }
    if (block.length > budget) {
      truncated = true
      lines.push(`…（digest 超限，其后消息未覆盖：seq > ${message.seq}）`)
      break
    }
    budget -= block.length
    lines.push(block, '')
  }
  return { digest: lines.join('\n'), truncated }
}

/** Total user-role vs human counts for a window, filling span.userMsg.total. */
export function countUserRole(session: TuiSession, window: ChapterWindow): number {
  return session.messages.filter(
    (m) => m.role === 'user' && m.seq >= window.firstMsgSeq && m.seq <= window.lastMsgSeq
  ).length
}
