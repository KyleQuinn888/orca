// TUI session reader: transcript projection, human-message counting (S2),
// chapter windowing, and digest construction for the summarizer.
// v1.1 (re-reviewed 2026-10-25): windows close the inter-chapter gap (the
// last covered message is the one BEFORE the next chapter starts), tails
// below half bandwidth merge into the previous chapter, and digests carry
// tool activity lines.

import type { Database } from 'bun:sqlite'

export type TuiMessage = {
  id: string
  seq: number
  timeCreated: number
  role: string
  human: boolean
  texts: string[]
  /** RAW SQLite data-column bytes; the hashing contract (never re-serialize). */
  rawData: string
  /** tool names from tool parts, for digest activity lines. */
  tools: string[]
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
         ) AS texts,
         (
           SELECT group_concat(json_extract(p.data, '$.tool'), char(10))
           FROM part p
           WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'tool'
         ) AS tools
         FROM message m WHERE m.session_id = ? ORDER BY m.sequence`
      )
      .all(sessionId) as {
      id: string
      sequence: number
      time_created: number
      data: string
      texts: string | null
      tools: string | null
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
      texts,
      rawData: row.data,
      tools: row.tools ? row.tools.split('\n').filter((t) => t.length > 0) : []
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

/**
 * Windows of ~target human messages. lastMsgSeq = the last COVERED message
 * (next chapter's firstMsgSeq - 1, or the session's final message), so an
 * answer to a chapter's last human message belongs to that chapter instead
 * of falling into the gap. A tail below half the bandwidth merges backward.
 */
export function proposeChapterWindows(
  session: TuiSession,
  options: { targetHuman?: number } = {}
): ChapterWindow[] {
  const target = options.targetHuman ?? 20
  const humanRows = session.messages.filter((m) => m.human)
  if (humanRows.length === 0) {
    return []
  }
  const lastSeq = session.messages.at(-1)!.seq
  const windows: ChapterWindow[] = []
  let start = 0
  for (let i = target; ; i += target) {
    if (i >= humanRows.length) {
      const remaining = humanRows.length - start
      if (remaining > 0) {
        pushWindow(humanRows, start, humanRows.length - 1, lastSeq, windows)
      }
      break
    }
    pushWindow(humanRows, start, i - 1, humanRows[i].seq - 1, windows)
    start = i
  }
  if (windows.length >= 2) {
    const tail = windows.at(-1)!
    if (tail.userMsg.human < Math.ceil(target / 2)) {
      windows.pop()
      const host = windows.at(-1)!
      host.lastMsgSeq = Math.max(host.lastMsgSeq, tail.lastMsgSeq)
      host.userMsg.human += tail.userMsg.human
      host.lastTime = tail.lastTime
      host.durationMin = Math.round(
        (Date.parse(tail.lastTime) - Date.parse(host.firstTime)) / 60000
      )
    }
  }
  return windows
}

function pushWindow(
  rows: TuiMessage[],
  from: number,
  to: number,
  lastCoveredSeq: number,
  windows: ChapterWindow[]
): void {
  if (to < from) {
    return
  }
  const first = rows[from]
  const last = rows[to]
  windows.push({
    index: windows.length + 1,
    firstMsgSeq: first.seq,
    lastMsgSeq: Math.max(last.seq, lastCoveredSeq),
    userMsg: { human: to - from + 1, total: 0 },
    firstTime: new Date(first.timeCreated).toISOString(),
    lastTime: new Date(last.timeCreated).toISOString(),
    durationMin: Math.round((last.timeCreated - first.timeCreated) / 60000)
  })
}

/**
 * Digest for one window: human messages in full, assistant turns trimmed,
 * tool activity as name-only lines. Bounded by maxChars; when clipped the
 * uncovered marker names the dropped range.
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
    if (message.role === 'user' && !message.human) {
      continue // system injection: skip entirely
    }
    let block: string
    if (message.human) {
      block = `[用户 seq ${message.seq}] ${message.texts.join('\n').slice(0, 4000)}`
    } else {
      const text = message.texts.join('\n')
      const toolLine = message.tools.length > 0 ? `〔工具：${message.tools.join('、')}〕` : ''
      const body = text.length > 800 ? `${text.slice(0, 800)}…(截断)` : text
      block = `[${message.role} seq ${message.seq}] ${body}${toolLine}`
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
