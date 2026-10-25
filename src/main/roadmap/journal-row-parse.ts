// Row parsing helpers for journal segmentation: classify journal rows and
// detect tier-signal patterns from raw row JSON. Extracted from
// journal-reader.ts so the segmentation logic stays under the line budget.

import type { TurnTerminalState } from './journal-reader'

export type ParsedRow = {
  kind: string
  turnItemId?: string
  turnState?: string
  turnOutcome?: string
  body?: Record<string, unknown>
  producerLinkage?: { agentId?: string; attempt?: number }
}

export function parseRow(rowJson: string): ParsedRow | null {
  try {
    return JSON.parse(rowJson) as ParsedRow
  } catch {
    return null
  }
}

function isTurnRow(parsed: ParsedRow): boolean {
  return parsed.kind === 'item' && parsed.body?.kind === 'turn'
}

export function isTerminalTurn(parsed: ParsedRow): TurnTerminalState | null {
  if (!isTurnRow(parsed)) {
    return null
  }
  const state = (parsed.body as { state?: string }).state
  if (state === 'completed' || state === 'interrupted' || state === 'unverifiable') {
    return state
  }
  return null
}

export function isCompactRow(parsed: ParsedRow): boolean {
  return (
    parsed.kind === 'item' &&
    (parsed.body as { presentation?: string })?.presentation === 'context-cleared'
  )
}

export function isMessageRow(parsed: ParsedRow): boolean {
  return parsed.kind === 'item' && parsed.body?.kind === 'message'
}

export function isToolCallRow(parsed: ParsedRow): boolean {
  return parsed.kind === 'item' && parsed.body?.kind === 'tool-call'
}

/** Detect git commit from tool-call input. NOT from tool name (name is Bash/shell). */
export function isGitCommit(parsed: ParsedRow): string | null {
  if (!isToolCallRow(parsed)) {
    return null
  }
  const body = parsed.body as { name?: string; input?: unknown; output?: { content?: string } }
  const cmd = extractCommand(body.input)
  if (!cmd) {
    return null
  }
  // Must contain "git commit" (not log/show/diff/dry-run)
  const lower = cmd.toLowerCase()
  if (!lower.includes('git') || !lower.includes('commit')) {
    return null
  }
  if (
    lower.includes('--dry-run') ||
    lower.includes('git log') ||
    lower.includes('git show') ||
    lower.includes('git diff')
  ) {
    return null
  }
  // Corroborate with output head if available
  const outputHead = body.output?.content?.slice(0, 100) ?? ''
  const shaMatch = /\[[\w-]+\s+[0-9a-f]{7,}\]/.exec(outputHead)
  return shaMatch ? shaMatch[0] : cmd.slice(0, 60)
}

function extractCommand(input: unknown): string | null {
  if (typeof input === 'string') {
    return input
  }
  if (input !== null && typeof input === 'object') {
    const obj = input as { command?: unknown }
    if (typeof obj.command === 'string') {
      return obj.command
    }
    if (Array.isArray(obj.command)) {
      return obj.command.join(' ')
    }
  }
  return null
}

export function isThreadGoalChange(parsed: ParsedRow): 'set' | 'cleared' | null {
  if (parsed.kind !== 'item') {
    return null
  }
  const body = parsed.body as { threadGoal?: { state?: string } }
  if (body?.threadGoal?.state === 'set') {
    return 'set'
  }
  if (body?.threadGoal?.state === 'cleared') {
    return 'cleared'
  }
  return null
}

export function isOrcaStop(parsed: ParsedRow): boolean {
  return parsed.kind === 'item' && (parsed.body as { orcaStop?: unknown })?.orcaStop !== undefined
}

export function isSlashCommand(parsed: ParsedRow): string | null {
  if (!isMessageRow(parsed)) {
    return null
  }
  const body = parsed.body as { sentAs?: string; command?: { name?: string } }
  if (body.sentAs === 'command' && body.command?.name && body.command.name !== 'compact') {
    return body.command.name
  }
  return null
}

/** Rough per-row projection size estimate (matches journal-digest folding). */
export function estimateProjectionChars(parsed: ParsedRow): number {
  if (isMessageRow(parsed)) {
    const body = parsed.body as { role?: string; content?: string }
    const text = body.content ?? ''
    return body.role === 'user' ? Math.min(text.length, 4000) + 20 : Math.min(text.length, 800) + 20
  }
  if (isToolCallRow(parsed)) {
    return 80 // name + target summary line
  }
  if (parsed.kind === 'item' && parsed.body?.kind === 'diff') {
    return 60 // file names + line counts
  }
  if (
    parsed.kind === 'item' &&
    (parsed.body?.kind === 'approval' || parsed.body?.kind === 'question')
  ) {
    return 120
  }
  return 10 // epoch/tombstone/lifecycle rows
}
