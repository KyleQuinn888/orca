// Card rendering: SummarizedChapter -> RoadmapCard (frontmatter assembly,
// body sections, evidence construction). Split from build.ts for the
// max-lines ratchet.

import type { ChapterWindow, TuiSession } from './tui-reader'
import { tuiEvidence, type Evidence } from './anchor'

import type { SummarizedChapter } from './summarizer'
import type { CardFrontmatter, RoadmapCard } from './card'

/**
 * S6 forgery guard: LLM free text is spliced into card bodies, so any line
 * that would parse as a structural block marker ('## …' headings, bare
 * 'pits:'/'anchors:'/'evidence:' keys) gets mangled with a '·' prefix, and
 * stray newlines collapse to '；' — parseCard can then never read a forged
 * evidence/pits block out of a body. Idempotent.
 */
export function sanitizeLlmText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.startsWith('## ') || /^(pits|anchors|evidence):$/.test(line) ? `·${line}` : line
    )
    .join('；')
}

export function renderCard(
  session: TuiSession,
  window: ChapterWindow,
  result: { kind: 'llm' | 'heuristic'; card: SummarizedChapter; reason?: string },
  truncated: boolean,
  dbPath: string,
  tzOffsetMin: number,
  chosen: ChapterWindow[]
): RoadmapCard {
  const covered = chosen.map((w) => ({ from: w.firstMsgSeq, to: w.lastMsgSeq }))
  const uncovered = complementRanges(0, session.messages.at(-1)?.seq ?? 0, covered)
  const frontmatter: CardFrontmatter = {
    v: 1,
    kind: 'session-chapter',
    source: 'tui-sqlite',
    session: session.id,
    workspace: session.directory,
    title: session.title,
    chapter: { index: window.index, slug: slugify(result.card.title) },
    span: {
      firstMsgSeq: window.firstMsgSeq,
      lastMsgSeq: window.lastMsgSeq,
      userMsg: window.userMsg
    },
    time: {
      firstTime: window.firstTime,
      lastTime: window.lastTime,
      durationMin: window.durationMin,
      tzOffsetMin,
      tzNote: '时间为章内首末人工消息时刻'
    },
    uncovered,
    quality: 'draft',
    provenance: result.kind === 'llm' ? 'llm' : 'heuristic',
    digestTruncated: truncated || undefined,
    schemaNote: `zcode TUI SQLite (${dbPath})；hashOf=tui-message-data 为 data 列原始字节`,
    extra: {}
  }
  const evidence = buildEvidence(session, window, result.card, dbPath)
  const body = [
    `# Ch.${window.index} ${result.card.title}${result.kind === 'heuristic' ? '（启发式降级）' : ''}`,
    result.reason && result.kind === 'heuristic' ? `> 降级原因：${result.reason}\n` : '',
    '## 要点',
    ...result.card.points.map((p) => `- ${sanitizeLlmText(p.text)}`),
    '',
    '## 关键决策',
    ...(result.card.decisions.length > 0
      ? result.card.decisions.map((d) => `- ${sanitizeLlmText(d.text)}`)
      : ['- 无']),
    '',
    '## 涉及文件/产物',
    ...(result.card.artifacts.length > 0
      ? result.card.artifacts.map((a) => `- ${sanitizeLlmText(a)}`)
      : ['- 无']),
    '',
    '## 坑',
    ...(result.card.pitfalls.length > 0
      ? result.card.pitfalls.map((p) => `- ${sanitizeLlmText(p.text)}`)
      : ['- 本段无'])
  ].join('\n')
  return {
    frontmatter,
    anchors: { source: 'tui-sqlite', origin: { db: 'tui-sqlite', path: dbPath } },
    evidence,
    pits: [],
    body
  }
}

function buildEvidence(
  session: TuiSession,
  window: ChapterWindow,
  summarized: SummarizedChapter,
  dbPath: string
): Evidence[] {
  const bySeq = new Map(session.messages.map((m) => [m.seq, m]))
  const sections: [string, { seq?: number; quote?: string }][] = [
    ...summarized.points.map((p, i) => [`要点${i + 1}`, p]),
    ...summarized.decisions.map((d, i) => [`决策${i + 1}`, d]),
    ...summarized.pitfalls.map((p, i) => [`坑${i + 1}`, p])
  ]
  const evidence: Evidence[] = []
  for (const [label, entry] of sections) {
    if (entry.seq === undefined) {
      continue
    }
    const message = bySeq.get(entry.seq)
    if (!message || message.seq < window.firstMsgSeq || message.seq > window.lastMsgSeq) {
      continue
    }
    // Quote is the structured pointer the LLM returns verbatim; body text
    // stays quote-free (human narrative vs machine pointer, per owner spec).
    evidence.push(tuiEvidence(label, { path: dbPath }, message, entry.quote))
  }
  return evidence
}

function complementRanges(
  from: number,
  to: number,
  covered: { from: number; to: number }[]
): UncoveredRange[] {
  const sorted = [...covered].sort((a, b) => a.from - b.from)
  const gaps: UncoveredRange[] = []
  let cursor = from
  for (const range of sorted) {
    if (range.from > cursor) {
      gaps.push({ fromSeq: cursor, toSeq: range.from - 1, note: '未生成章节' })
    }
    cursor = Math.max(cursor, range.to + 1)
  }
  if (cursor <= to) {
    gaps.push({ fromSeq: cursor, toSeq: to, note: '未生成章节' })
  }
  return gaps
}

/** Filename-safe slug: strips path separators/metacharacters, collapses
 * traversal dots, trims, caps length — never empty, never a path fragment. */
export function slugify(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 60) || 'untitled'
  )
}
