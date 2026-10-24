// roadmap build CLI — SessionRoadMap Approach A slice, schema v1.1.
//   bun roadmap/build.ts <sessionId> [--source tui] [--chapter N] [--list] [--no-llm] [--out <dir>]
// Writes .roadmap/001/<sessionId>/<nnn>-<slug>.md cards + refreshes the S1 index.
// S6 is a GATE: evidence anchors are generated from per-point seqs and verified
// against the source DB before a card is stamped anchorsVerifiedAt.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SourceLocationError, locateSource, openTui } from './core/sources'
import {
  buildDigest,
  countUserRole,
  proposeChapterWindows,
  readTuiSession,
  type ChapterWindow,
  type TuiSession
} from './core/tui-reader'
import { writeCard, type CardFrontmatter, type RoadmapCard, type UncoveredRange } from './core/card'
import { refreshIndex } from './core/index-card'
import { summarizeChapter, type SummarizedChapter } from './core/summarizer'
import { tuiEvidence, verifyEvidence, type Evidence } from './core/anchor'

const args = parseArgs(process.argv.slice(2))
const promptTemplate = readFileSync(join(import.meta.dir, 'prompts', 'task-node.md'), 'utf8')

async function main(): Promise<void> {
  if (!args.sessionId) {
    console.error(
      'usage: bun roadmap/build.ts <sessionId> [--source tui] [--chapter N] [--list] [--no-llm] [--out <dir>]'
    )
    process.exit(2)
  }
  const source = locateSource({ source: args.source ?? 'tui' })
  if (source.kind !== 'tui') {
    console.error('journal-source chapters land with the R1 service; this slice reads TUI sessions')
    process.exit(2)
  }
  const { db, path: dbPath } = openTui()
  const session = readTuiSession(db, args.sessionId)
  db.close()
  const windows = proposeChapterWindows(session)
  if (args.list) {
    console.log(`session: ${session.title} (${session.messages.length} msgs)`)
    for (const w of windows) {
      console.log(
        `  ch ${w.index}: seq ${w.firstMsgSeq}-${w.lastMsgSeq} human=${w.userMsg.human} ${w.firstTime.slice(0, 16)} (${w.durationMin}min)`
      )
    }
    return
  }
  const chosen = args.chapter ? windows.filter((w) => w.index === args.chapter) : windows
  if (chosen.length === 0) {
    throw new Error(`--chapter ${args.chapter}: no such chapter`)
  }
  const outRoot =
    args.out ?? join(session.directory || process.cwd(), '.roadmap', '001', session.id)
  const tzOffsetMin = -new Date().getTimezoneOffset()
  const bySeq = new Map(session.messages.map((m) => [m.seq, m]))
  for (const window of chosen) {
    window.userMsg.total = countUserRole(session, window)
    const { digest, truncated } = buildDigest(session, window)
    const result = args.noLlm
      ? { kind: 'heuristic' as const, card: heuristicFrom(session, window), reason: '--no-llm' }
      : await summarizeChapter({ digest, promptTemplate })
    const card = renderCard(session, window, result, truncated, dbPath, tzOffsetMin, chosen)
    // S6 gate: every accepted anchor MUST carry a quote (no quote = no
    // verification = dropped as quote-missing). Failing anchors are dropped
    // and counted (anchorsDropped): a shipped card carries only one-hop-
    // verifiable anchors. anchorsVerifiedAt stamps only when every 要点
    // claim keeps at least one surviving anchor — no zero-evidence pass.
    const checks = card.evidence.map((e) => ({
      claim: e.claim,
      quote: e.quote ?? '',
      evidence: e
    }))
    const failures = verifyEvidence(checks, (evidence) => {
      const message = bySeq.get(evidence.seq)
      if (!message || evidence.quote === undefined || evidence.quote === '') {
        return { hashPayload: null, searchText: null }
      }
      return {
        hashPayload: message.rawData,
        searchText: `${message.rawData}\n${message.rawParts.join('\n')}`
      }
    })
    if (failures.length > 0) {
      const failedClaims = new Set(failures.map((f) => f.claim))
      for (const failure of failures) {
        console.error(
          `[roadmap] S6 DROP ch${window.index} ${failure.claim}: ${failure.reason} ${failure.detail ?? ''}`
        )
      }
      card.evidence = card.evidence.filter((e) => !failedClaims.has(e.claim))
      card.frontmatter.anchorsDropped = failures.length
    }
    const pointClaims = [...result.card.points.keys()].map((i) => `要点${i + 1}`)
    const coveredClaims = new Set(card.evidence.map((e) => e.claim))
    const uncoveredPoints = pointClaims.filter((c) => !coveredClaims.has(c))
    if (card.evidence.length > 0 && uncoveredPoints.length === 0) {
      card.frontmatter.anchorsVerifiedAt = new Date().toISOString()
    } else if (uncoveredPoints.length > 0) {
      console.error(
        `[roadmap] S6 ch${window.index} points without surviving anchors: ${uncoveredPoints.join(', ')} — no stamp`
      )
    }
    const written = writeCard(outRoot, card)
    console.log(
      `${written.outcome}: ${written.path} [${result.kind}] evidence=${card.evidence.length} dropped=${failures.length} verified=${card.frontmatter.anchorsVerifiedAt !== undefined}`
    )
  }
  refreshIndex(outRoot, {
    source: 'tui-sqlite',
    session: session.id,
    workspace: session.directory,
    title: session.title,
    chapters: [],
    sessionUncoveredNote: `共 ${windows.length} 章；未生成区间见各章 uncovered`,
    tzOffsetMin
  })
  console.log(`index refreshed: ${join(outRoot, '000-index.md')}`)
}

function renderCard(
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
    ...result.card.points.map((p) => `- ${p.text}`),
    '',
    '## 关键决策',
    ...(result.card.decisions.length > 0
      ? result.card.decisions.map((d) => `- ${d.text}`)
      : ['- 无']),
    '',
    '## 涉及文件/产物',
    ...(result.card.artifacts.length > 0 ? result.card.artifacts.map((a) => `- ${a}`) : ['- 无']),
    '',
    '## 坑',
    ...(result.card.pitfalls.length > 0
      ? result.card.pitfalls.map((p) => `- ${p.text}`)
      : ['- 本段无'])
  ].join('\n')
  return {
    frontmatter,
    anchors: { source: 'tui-sqlite', origin: { db: 'tui-sqlite', path: dbPath } },
    evidence,
    body
  }
}

type SeqText = { text: string; seq?: number }

function buildEvidence(
  session: TuiSession,
  window: ChapterWindow,
  summarized: SummarizedChapter,
  dbPath: string
): Evidence[] {
  const bySeq = new Map(session.messages.map((m) => [m.seq, m]))
  const sections: [string, SeqText][] = [
    ...summarized.points.map((p, i) => [`要点${i + 1}`, p] as [string, SeqText]),
    ...summarized.decisions.map((d, i) => [`决策${i + 1}`, d] as [string, SeqText]),
    ...summarized.pitfalls.map((p, i) => [`坑${i + 1}`, p] as [string, SeqText])
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
    evidence.push(tuiEvidence(label, { path: dbPath }, message, extractQuote(entry.text)))
  }
  return evidence
}

/** First quoted span (ASCII or CJK quotes) in a point, else undefined. */
export function extractQuote(text: string): string | undefined {
  const ascii = /"([^"]{4,200})"/.exec(text)
  if (ascii) {
    return ascii[1]
  }
  const cjk = /\u201c([^\u201d]{4,200})\u201d/.exec(text)
  return cjk?.[1]
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

function heuristicFrom(session: TuiSession, window: ChapterWindow): SummarizedChapter {
  const humans = session.messages.filter(
    (m) => m.human && m.seq >= window.firstMsgSeq && m.seq <= window.lastMsgSeq
  )
  return {
    title: `${session.title.slice(0, 30)}（区间摘要待生成）`,
    points: humans.slice(0, 5).map((m) => ({
      text: `**用户输入摘录（seq ${m.seq}）**。${m.texts.join(' ').slice(0, 100)}…`,
      seq: m.seq
    })),
    decisions: [],
    artifacts: [],
    pitfalls: []
  }
}

function slugify(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  )
}

function parseArgs(argv: string[]): {
  sessionId?: string
  source?: 'tui' | 'journal'
  chapter?: number
  list: boolean
  noLlm: boolean
  out?: string
} {
  const parsed = { list: false, noLlm: false } as ReturnType<typeof parseArgs>
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') {
      parsed.list = true
    } else if (arg === '--no-llm') {
      parsed.noLlm = true
    } else if (arg === '--source') {
      parsed.source = argv[++i] as 'tui' | 'journal'
    } else if (arg === '--chapter') {
      parsed.chapter = Number(argv[++i])
    } else if (arg === '--out') {
      parsed.out = resolve(argv[++i])
    } else if (!arg.startsWith('--')) {
      parsed.sessionId = arg
    }
  }
  return parsed
}

main().catch((error) => {
  if (error instanceof SourceLocationError) {
    console.error(`[roadmap] ${error.state}: ${error.message}`)
    process.exit(3)
  }
  console.error(`[roadmap] ${String(error)}`)
  process.exit(1)
})
