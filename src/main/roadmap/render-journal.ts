// Journal card renderer: produce a RoadmapCard from a chapter cut and its
// rows, with journal-source evidence anchors and S6 lookup.

import { journalEvidence, type Evidence } from '../../roadmap/core/anchor'
import type { RoadmapCard, CardFrontmatter } from '../../roadmap/core/card'
import { sanitizeLlmText } from '../../roadmap/core/render'
import type { ChapterCut, JournalRowRef } from './journal-reader'
import type { SummarizedChapter } from './summarizer'

export function renderJournalCard(args: {
  sessionId: string
  sessionTitle: string
  workspace: string
  cut: ChapterCut
  rows: JournalRowRef[]
  summarized: SummarizedChapter
  provenance: 'llm' | 'heuristic'
  dbPath: string
  profile: string
  tzOffsetMin: number
  uncovered: { fromSeq: number; toSeq: number; note?: string }[]
  digestTruncated: boolean
}): RoadmapCard {
  const { cut, summarized, rows } = args

  const bySeq = new Map(rows.map((r) => [r.seq, r]))

  const frontmatter: CardFrontmatter = {
    v: 1,
    kind: 'session-chapter',
    source: 'orca-journal',
    session: args.sessionId,
    workspace: args.workspace,
    title: args.sessionTitle,
    chapter: { index: cut.index, slug: slugify(summarized.title) },
    span: {
      firstMsgSeq: cut.fromSeq,
      lastMsgSeq: cut.toSeq,
      userMsg: { human: countHumanMessages(rows), total: countUserRows(rows) }
    },
    time: {
      firstTime: isoFromTs(rows[0]?.ts),
      lastTime: isoFromTs(rows.at(-1)?.ts),
      durationMin: computeDurationMin(rows),
      tzOffsetMin: args.tzOffsetMin
    },
    uncovered: args.uncovered,
    quality: 'draft',
    provenance: args.provenance,
    digestTruncated: args.digestTruncated || undefined,
    schemaNote: `Orca journal SQLite (${args.dbPath}, profile ${args.profile}); hashOf=journal-row-json 为 row_json 列原始字节`,
    extra: {}
  }

  // Build evidence from points with seq
  const evidence = buildJournalEvidence(summarized, cut, bySeq, args)

  // Build body
  const body = [
    `# Ch.${cut.index} ${sanitizeLlmText(summarized.title)}`,
    '',
    '## 要点',
    ...summarized.points.map((p) => `- ${sanitizeLlmText(p.text)}`),
    '',
    '## 关键决策',
    ...(summarized.decisions.length > 0
      ? summarized.decisions.map((d) => `- ${sanitizeLlmText(d.text)}`)
      : ['- 无']),
    '',
    '## 涉及文件/产物',
    ...(summarized.artifacts.length > 0
      ? summarized.artifacts.map((a) => `- ${sanitizeLlmText(a)}`)
      : ['- 无']),
    '',
    '## 坑',
    ...(summarized.pitfalls.length > 0
      ? summarized.pitfalls.map((p) => `- ${sanitizeLlmText(p.text)}`)
      : ['- 本段无'])
  ].join('\n')

  return {
    frontmatter,
    anchors: {
      source: 'orca-journal',
      origin: { db: 'orca-journal', path: args.dbPath, profile: args.profile }
    },
    evidence,
    pits: summarized.pitfalls.map((pit) => ({
      text: sanitizeLlmText(pit.text),
      keywords: pit.keywords ?? [],
      symptom: pit.symptom,
      fix: pit.fix,
      seq: pit.seq,
      quote: pit.quote
    })),
    terms: summarized.terms?.map((t) => ({ standard: t.standard, jargon: t.jargon })),
    body
  }
}

function buildJournalEvidence(
  summarized: SummarizedChapter,
  cut: ChapterCut,
  bySeq: Map<number, JournalRowRef>,
  args: { sessionId: string; dbPath: string; profile: string }
): Evidence[] {
  const sections: [string, { seq?: number; quote?: string }][] = [
    ...summarized.points.map(
      (p, i) => [`要点${i + 1}`, p] as [string, { seq?: number; quote?: string }]
    ),
    ...summarized.decisions.map(
      (d, i) => [`决策${i + 1}`, d] as [string, { seq?: number; quote?: string }]
    ),
    ...summarized.pitfalls.map(
      (p, i) => [`坑${i + 1}`, p] as [string, { seq?: number; quote?: string }]
    )
  ]

  const evidence: Evidence[] = []
  for (const [label, entry] of sections) {
    if (entry.seq === undefined) {
      continue
    }
    const row = bySeq.get(entry.seq)
    if (!row || row.seq < cut.fromSeq || row.seq > cut.toSeq) {
      continue
    }
    evidence.push(
      journalEvidence(
        label,
        { path: args.dbPath, profile: args.profile },
        {
          sessionId: args.sessionId,
          epoch: cut.epoch,
          seq: row.seq,
          rowJson: row.rowJson
        },
        entry.quote
      )
    )
  }
  return evidence
}

// ─── S6 lookup for journal cards ────────────────────────────────────────

export function journalS6Lookup(db: {
  query: (sql: string, ...params: unknown[]) => { get?: (...p: unknown[]) => unknown }
}): (evidence: Evidence) => { hashPayload: string | null; searchText: string | null } {
  return (evidence) => {
    // ref format: "sessionId@epoch:seq"
    const parts = evidence.ref.split(/[@:]/)
    if (parts.length !== 3) {
      return { hashPayload: null, searchText: null }
    }
    const [, epoch, seqStr] = parts
    const seq = Number(seqStr)
    if (Number.isNaN(seq)) {
      return { hashPayload: null, searchText: null }
    }
    // sessionId is everything before the last @
    const sessionId = evidence.ref.slice(0, evidence.ref.lastIndexOf('@'))
    const row = db
      .query('SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
      .get(sessionId, epoch, seq) as { row_json: string } | null
    if (!row) {
      return { hashPayload: null, searchText: null }
    }
    return { hashPayload: row.row_json, searchText: row.row_json }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function slugify(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/\.\./g, '.')
      .replace(/^\./, '')
      .slice(0, 60) || 'untitled'
  )
}

function isoFromTs(ts?: number): string {
  if (ts === undefined) {
    return ''
  }
  return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString()
}

function computeDurationMin(rows: JournalRowRef[]): number {
  if (rows.length < 2) {
    return 0
  }
  const first = rows[0]!.ts ?? 0
  const last = rows.at(-1)!.ts ?? 0
  return Math.round((last - first) / 60000)
}

function countHumanMessages(rows: JournalRowRef[]): number {
  let count = 0
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.rowJson) as {
        body?: { kind?: string; role?: string; content?: string }
      }
      if (parsed.body?.kind === 'message' && parsed.body.role === 'user' && parsed.body.content) {
        if (!isSystemInjection(parsed.body.content)) {
          count++
        }
      }
    } catch {
      // skip unparseable
    }
  }
  return count
}

function countUserRows(rows: JournalRowRef[]): number {
  let count = 0
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.rowJson) as { body?: { kind?: string; role?: string } }
      if (parsed.body?.kind === 'message' && parsed.body.role === 'user') {
        count++
      }
    } catch {
      // skip
    }
  }
  return count
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
