// Journal digest construction: fold journal rows into a flat text digest
// for the LLM summarizer. Mirrors the A-slice tui-reader projection.

import type { JournalRowRef } from './journal-reader'

export type DigestResult = {
  digest: string
  truncated: boolean
  totalChars: number
}

export function buildJournalDigest(
  sessionId: string,
  sessionTitle: string,
  rows: JournalRowRef[],
  termHeader: string,
  options: { maxChars?: number } = {}
): DigestResult {
  const maxChars = options.maxChars ?? 24_000
  const lines: string[] = [`会话：${sessionTitle}（${sessionId}）`]

  if (termHeader.length > 0) {
    lines.push(termHeader)
  }

  let budget = maxChars - lines.join('\n').length
  let truncated = false
  let totalChars = 0

  for (const row of rows) {
    const block = foldRow(row)
    if (block === null) {
      continue
    }
    totalChars += block.length

    if (block.length > budget) {
      truncated = true
      lines.push(`…（digest 超限，其后行未覆盖：seq > ${row.seq}）`)
      break
    }
    budget -= block.length
    lines.push(block, '')
  }

  return { digest: lines.join('\n'), truncated, totalChars }
}

function foldRow(row: JournalRowRef): string | null {
  try {
    const parsed = JSON.parse(row.rowJson) as {
      kind: string
      body?: {
        kind?: string
        role?: string
        content?: string
        name?: string
        input?: unknown
        state?: string
        endedAs?: string
        output?: { content?: string }
        presentation?: string
        command?: { name?: string }
        sentAs?: string
      }
    }

    // Skip non-item rows (epoch, tombstone, lifecycle-batch, queue, etc.)
    if (parsed.kind !== 'item' || !parsed.body) {
      return null
    }

    const body = parsed.body

    // ── message ──
    if (body.kind === 'message') {
      const text = body.content ?? ''
      if (body.role === 'user') {
        // System injections: skip (task-notification, system-reminder, etc.)
        if (isSystemInjection(text)) {
          return null
        }
        return `[user seq ${row.seq}] ${text.slice(0, 4000)}`
      }
      // assistant
      const truncatedText = text.length > 800 ? `${text.slice(0, 800)}…(截断)` : text
      return `[assistant seq ${row.seq}] ${truncatedText}`
    }

    // ── tool-call ──
    if (body.kind === 'tool-call') {
      const toolName = body.name ?? 'unknown'
      const cmd = extractCommandSummary(body.input)
      const state =
        body.state === 'completed'
          ? ''
          : ` (${body.state}${body.endedAs ? `/${body.endedAs}` : ''})`
      return `[tool seq ${row.seq}] ${toolName}${cmd ? `: ${cmd}` : ''}${state}`
    }

    // ── diff ──
    if (body.kind === 'diff') {
      const fileNames = extractDiffFiles(body)
      return `[diff seq ${row.seq}] ${fileNames}`
    }

    // ── approval / question ──
    if (body.kind === 'approval' || body.kind === 'question') {
      const prompt = (body as { prompt?: string }).prompt ?? body.kind
      return `[${body.kind} seq ${row.seq}] ${prompt.slice(0, 120)}`
    }

    // ── turn ──
    if (body.kind === 'turn') {
      const state = body.state ?? 'unknown'
      const outcome = (body as { outcome?: string }).outcome
      return `[turn seq ${row.seq}] ${state}${outcome ? ` (${outcome})` : ''}`
    }

    // ── status ──
    if (body.kind === 'status') {
      const presentation = body.presentation
      if (presentation === 'context-cleared') {
        return `[compact seq ${row.seq}] context cleared`
      }
      if (body.command?.name) {
        return `[command seq ${row.seq}] /${body.command.name}`
      }
      return null // other status rows: skip
    }

    return null
  } catch {
    return null
  }
}

const INJECTION_MARKERS = [
  '<task-notification>',
  '<system-reminder>',
  '[SYSTEM]',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  'The TodoWrite tool hasn\u2019t been used',
  "The TodoWrite tool hasn't been used"
]

function isSystemInjection(text: string): boolean {
  return INJECTION_MARKERS.some((m) => text.includes(m))
}

function extractCommandSummary(input: unknown): string | null {
  if (typeof input === 'string') {
    return input.slice(0, 80)
  }
  if (input !== null && typeof input === 'object') {
    const obj = input as { command?: unknown }
    if (typeof obj.command === 'string') {
      return obj.command.slice(0, 80)
    }
    if (Array.isArray(obj.command)) {
      return obj.command.join(' ').slice(0, 80)
    }
  }
  return null
}

function extractDiffFiles(body: Record<string, unknown>): string {
  const paths = body['paths'] ?? body['files']
  if (Array.isArray(paths)) {
    return paths.slice(0, 5).join(', ')
  }
  if (typeof paths === 'string') {
    return paths.slice(0, 120)
  }
  return '(diff)'
}
