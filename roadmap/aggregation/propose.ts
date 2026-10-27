// LLM subdivision proposer — spec layer-002-003 v7.3
// Trigger: folded group > 8 chapters. Already-proposed guard with tail exception.
// Atomic set validation; attempt-event backoff (digest excludes attempt events).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { sha256Hex, ulid, type MarkEvent } from './marks-store'
import type { Chapter, Group, FoldResult } from './fold'

export const PROPOSAL_TRIGGER_CHAPTERS = 8

export type SpawnLLM = (prompt: string) => Promise<string>

/** Real zcode -p spawn (stable cwd, 600s timeout + 1 retry handled by caller policy). */
export function zcodeSpawnLLM(): SpawnLLM {
  return async (prompt: string): Promise<string> => {
    const tmp = mkdtempSync(join(tmpdir(), 'roadmap-propose-'))
    try {
      const zcodeJs = join(
        homedir(),
        'AppData',
        'Roaming',
        'npm',
        'node_modules',
        'zcode-app-cli',
        'bin',
        'zcode.js'
      )
      return await new Promise<string>((resolve, reject) => {
        const child = spawn('node', [zcodeJs, '-p', prompt], { cwd: tmp, windowsHide: true })
        let out = ''
        child.stdout.on('data', (c) => {
          out += c
        })
        child.stderr.on('data', () => {})
        child.on('close', (code) =>
          code === 0 ? resolve(out) : reject(new Error(`zcode exited ${code}`))
        )
        setTimeout(() => {
          child.kill()
          reject(new Error('zcode timeout'))
        }, 300_000).unref()
      })
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ok */
      }
    }
  }
}

// ─── Guard: already-proposed + tail exception ───────────────────────────

/**
 * Interior open llm anchors block re-proposal; the tail after the last anchor
 * may be proposed on its own if it exceeds the trigger size.
 */
export function proposalSpan(
  group: Group,
  openLlmCuts: MarkEvent[]
): { span: Chapter[]; blocked: boolean } {
  const lastChapter = group.chapters.at(-1)!.index
  const interiorAnchors = openLlmCuts
    .map((c) => c.anchor?.chapter)
    .filter((p): p is number => p !== undefined && p > group.startChapter && p <= lastChapter)
  if (interiorAnchors.length === 0) {
    return { span: group.chapters, blocked: false }
  }
  const lastAnchor = Math.max(...interiorAnchors)
  const tail = group.chapters.filter((c) => c.index >= lastAnchor)
  return { span: tail, blocked: tail.length <= PROPOSAL_TRIGGER_CHAPTERS }
}

// ─── Atomic set validation ──────────────────────────────────────────────

export type CutCandidate = { chapter: number; firstMsgSeq: number }

export type ValidationContext = {
  /** positions (chapter indices) that already carry an active boundary */
  activeBoundaryPositions: Set<number>
  /** open llm anchor positions to avoid — EXCLUDING the candidate group's own members */
  openLlmPositionsExcludingGroup: Set<number>
}

/** Returns null when valid; otherwise the first failure reason (whole group invalid). */
export function validateCuts(
  cuts: CutCandidate[],
  span: Chapter[],
  ctx: ValidationContext
): string | null {
  if (cuts.length === 0) {
    return 'empty cut set'
  }
  const spanStart = span[0]?.index ?? 0
  const spanEnd = span.at(-1)?.index ?? 0
  const byIndex = new Map(span.map((c) => [c.index, c]))

  // rule 5: anchors must hit live chapters of the span with consistent identity
  for (const cut of cuts) {
    const ch = byIndex.get(cut.chapter)
    if (!ch) {
      return `cut @Ch.${cut.chapter} outside span Ch.${spanStart}-${spanEnd}`
    }
    if (ch.firstMsgSeq !== cut.firstMsgSeq) {
      return `cut @Ch.${cut.chapter} firstMsgSeq ${cut.firstMsgSeq} != chapter's ${ch.firstMsgSeq}`
    }
  }
  // rule 1: strictly interior positions (not the span's own start boundary, not past the end)
  for (const cut of cuts) {
    if (cut.chapter <= spanStart || cut.chapter > spanEnd) {
      return `cut @Ch.${cut.chapter} not strictly interior to span Ch.${spanStart}-${spanEnd}`
    }
  }
  // rule 2: no collision with active boundaries or other groups' open llm anchors
  for (const cut of cuts) {
    if (ctx.activeBoundaryPositions.has(cut.chapter)) {
      return `cut @Ch.${cut.chapter} collides with an active boundary`
    }
    if (ctx.openLlmPositionsExcludingGroup.has(cut.chapter)) {
      return `cut @Ch.${cut.chapter} collides with another open llm anchor`
    }
  }
  // rule 6: pairwise distinct positions
  const seen = new Set<number>()
  for (const cut of cuts) {
    if (seen.has(cut.chapter)) {
      return `duplicate cut @Ch.${cut.chapter}`
    }
    seen.add(cut.chapter)
  }
  // rule 3: count cap
  if (cuts.length > Math.floor(span.length / 2)) {
    return `cut count ${cuts.length} > floor(${span.length}/2)`
  }
  // rule 4: all cuts applied at once — every run must be >= 2 chapters
  const positions = [...seen].sort((a, b) => a - b)
  let prev = spanStart
  for (const p of positions) {
    const runLen = span.filter((c) => c.index >= prev && c.index < p).length
    if (runLen < 2) {
      return `run Ch.${prev}-${p - 1} has ${runLen} chapter(s) < 2`
    }
    prev = p
  }
  const tailLen = span.filter((c) => c.index >= prev).length
  if (tailLen < 2) {
    return `tail run from Ch.${prev} has ${tailLen} chapter(s) < 2`
  }
  return null
}

// ─── Attempt backoff ────────────────────────────────────────────────────

export function attemptDigest(groupKey: string, groupHash: string, events: MarkEvent[]): string {
  const nonAttempt = events.filter((e) => e.op !== 'attempt')
  return sha256Hex(`${groupKey}|${groupHash}|${sha256Hex(JSON.stringify(nonAttempt))}`).slice(0, 16)
}

/** Backoff: same digest + validation-failed => no retry; llm-failed may retry. */
export function shouldAttempt(events: MarkEvent[], groupKey: string, digest: string): boolean {
  const attempts = events
    .filter((e) => e.op === 'attempt' && e.groupKey === groupKey)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const last = attempts.at(-1)
  if (!last) {
    return true
  }
  if (last.digest === digest && last.outcome === 'validation-failed') {
    return false
  }
  return true
}

export function attemptEvent(
  session: string,
  groupKey: string,
  digest: string,
  outcome: 'validation-failed' | 'llm-failed' | 'succeeded'
): MarkEvent {
  return {
    id: `mk-${ulid()}`,
    op: 'attempt',
    at: new Date().toISOString(),
    session,
    by: 'system',
    groupKey,
    digest,
    outcome
  }
}

// ─── Proposer ───────────────────────────────────────────────────────────

export type ProposalOutcome =
  | { kind: 'none' }
  | { kind: 'events'; events: MarkEvent[] } // attempt(s) + add-cut events (pending)
  | { kind: 'error'; message: string }

export async function proposeForGroup(
  sessionId: string,
  group: Group,
  foldResult: FoldResult,
  allEvents: MarkEvent[],
  spawnLLM: SpawnLLM
): Promise<ProposalOutcome> {
  if (group.chapters.length <= PROPOSAL_TRIGGER_CHAPTERS) {
    return { kind: 'none' }
  }

  const { span, blocked } = proposalSpan(group, foldResult.openLlmCuts)
  if (blocked) {
    return { kind: 'none' }
  }
  if (span.length <= PROPOSAL_TRIGGER_CHAPTERS) {
    return { kind: 'none' }
  }

  const groupKey = group.boundaryKey
  const digest = attemptDigest(groupKey, group.chapterSetHash, allEvents)
  if (!shouldAttempt(allEvents, groupKey, digest)) {
    return { kind: 'none' }
  }

  const listing = span
    .map(
      (c) =>
        `Ch.${c.index}｜${c.heading}${c.points[0] ? `｜要点: ${c.points[0]}` : ''}${c.decisions[0] ? `｜决策: ${c.decisions[0]}` : ''}`
    )
    .join('\n')
  const prompt = `你是项目历史分析师。以下章节卡序列属于同一段连续工作（编号为章 index）。请在其中挑出语义切割点，把这段切成 3-8 章的工作弧线组。

会话: ${sessionId}

${listing}

输出严格 JSON：
{"cuts": [{"chapter": <章index，切点在该章之前>, "rationale": "<一句话：前弧收束/新弧开启>", "confidence": <0-1>}]}

规则：
- 切点必须是上面列出的章 index（边界在该章之前），不得是首章
- 目标切出 3-8 章的组；任何切出的段不得少于 2 章
- 只在语义弧线切换处切；弧线清晰时宁可少切`

  let lastError = ''
  for (let retry = 0; retry < 2; retry++) {
    let stdout: string
    try {
      stdout = await spawnLLM(prompt)
    } catch (e) {
      lastError = `spawn failed: ${(e as Error).message}`
      continue // llm-failed: retry once, then record llm-failed attempt
    }
    const jsonMatch = stdout.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      lastError = 'no JSON in LLM output'
      continue
    }
    let parsed: { cuts?: { chapter?: number; rationale?: string; confidence?: number }[] }
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch {
      lastError = 'invalid JSON from LLM'
      continue
    }
    const cuts: CutCandidate[] = []
    let parseOk = true
    for (const c of parsed.cuts ?? []) {
      const ch = span.find((x) => x.index === c.chapter)
      if (!ch || typeof c.chapter !== 'number') {
        parseOk = false
        lastError = `LLM cut chapter ${c.chapter} not in span`
        break
      }
      cuts.push({ chapter: c.chapter, firstMsgSeq: ch.firstMsgSeq })
    }
    if (!parseOk) {
      continue
    }

    const activeBoundaryPositions = new Set(foldResult.groups.map((g) => g.startChapter))
    // a NEW proposal has no members of its own yet, so all open llm anchors count as "other groups'"
    const openLlmPositionsExcludingGroup = new Set(
      foldResult.openLlmCuts.filter((c) => c.anchor).map((c) => c.anchor!.chapter)
    )
    const invalid = validateCuts(cuts, span, {
      activeBoundaryPositions,
      openLlmPositionsExcludingGroup
    })
    if (invalid) {
      lastError = invalid
      continue // validation failed — retry once, then record validation-failed
    }

    const pgId = `pg-${ulid()}`
    const now = new Date().toISOString()
    const events: MarkEvent[] = [
      attemptEvent(sessionId, groupKey, digest, 'succeeded'),
      ...cuts.map((cut) => ({
        id: `mk-${ulid()}`,
        op: 'add-cut' as const,
        at: now,
        session: sessionId,
        anchor: { firstMsgSeq: cut.firstMsgSeq, chapter: cut.chapter },
        by: 'llm' as const,
        proposalGroupId: pgId,
        evidence: parsed.cuts?.find((c) => c.chapter === cut.chapter)?.rationale ?? ''
      }))
    ]
    return { kind: 'events', events }
  }

  const failedValidation =
    lastError.startsWith('cut') ||
    lastError.includes('collide') ||
    lastError.includes('run') ||
    lastError.includes('duplicate') ||
    lastError.includes('count')
  return {
    kind: 'events',
    events: [
      attemptEvent(
        sessionId,
        groupKey,
        digest,
        failedValidation ? 'validation-failed' : 'llm-failed'
      )
    ]
  }
}
