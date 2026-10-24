// S1 session index card: the always-resident layer (~1k tokens/session).
// v1.1 (re-reviewed 2026-10-25): kind: session-index (no chapter block, never
// handEdited-protected), slug column so consumers resolve chapter files from
// the index alone, titles escaped for the table, rows sorted by parsed index.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseCard, writeCard, type RoadmapCard } from './card'

export function buildIndexCard(args: {
  source: 'tui-sqlite' | 'orca-journal'
  session: string
  workspace: string
  title: string
  chapters: RoadmapCard[]
  sessionUncoveredNote: string
  tzOffsetMin: number
}): RoadmapCard {
  const chapters = [...args.chapters].sort((a, b) => chapterIndex(a) - chapterIndex(b))
  const first = chapters.at(0)
  const last = chapters.at(-1)
  return {
    frontmatter: {
      v: 1,
      kind: 'session-index',
      source: args.source,
      session: args.session,
      workspace: args.workspace,
      title: args.title,
      span: first
        ? {
            firstMsgSeq: first.frontmatter.span.firstMsgSeq,
            lastMsgSeq: last!.frontmatter.span.lastMsgSeq,
            userMsg: {
              human: chapters.reduce((n, c) => n + c.frontmatter.span.userMsg.human, 0),
              total: chapters.reduce((n, c) => n + c.frontmatter.span.userMsg.total, 0)
            }
          }
        : { firstMsgSeq: 0, lastMsgSeq: 0, userMsg: { human: 0, total: 0 } },
      time: first
        ? {
            firstTime: first.frontmatter.time.firstTime,
            lastTime: last!.frontmatter.time.lastTime,
            durationMin: chapters.reduce((n, c) => n + c.frontmatter.time.durationMin, 0),
            tzOffsetMin: args.tzOffsetMin,
            tzNote: 'durationMin 为各章活跃时长之和，不含章间空隙'
          }
        : {
            firstTime: '',
            lastTime: '',
            durationMin: 0,
            tzOffsetMin: args.tzOffsetMin
          },
      // Uncovered ranges live structured on each chapter; the index only
      // notes the ledger state (nonexistent while windows partition).
      uncovered: [],
      quality: 'draft',
      provenance: 'llm',
      schemaNote: args.sessionUncoveredNote,
      extra: {}
    },
    anchors: null,
    evidence: [],
    body: renderIndexBody(chapters)
  }
}

function chapterIndex(card: RoadmapCard): number {
  return card.frontmatter.chapter?.index ?? 0
}

function renderIndexBody(chapters: RoadmapCard[]): string {
  const lines = [
    '# 会话索引',
    '',
    '| Ch | slug | 标题 | 区间 | 人工 | 时间(章内) | 状态 | 来源 |',
    '|---|---|---|---|---|---|---|---|'
  ]
  for (const card of chapters) {
    const heading = /^#\s+(?:Ch\.\d+\s+)?(.+)$/m.exec(card.body)
    const f = card.frontmatter
    lines.push(
      `| ${chapterIndex(card)} | ${f.chapter?.slug ?? ''} | ${escapeCell(heading?.[1] ?? f.chapter?.slug ?? '')} | seq ${f.span.firstMsgSeq}–${f.span.lastMsgSeq} | ${f.span.userMsg.human} | ${f.time.firstTime.slice(0, 16)} | ${f.quality}/${f.provenance} | ${f.source} |`
    )
  }
  return lines.join('\n')
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').slice(0, 80)
}

export function refreshIndex(directory: string, args: Parameters<typeof buildIndexCard>[0]): void {
  // Re-scan chapter cards from disk so the index reflects reality, not memory;
  // unparseable siblings are skipped (they quarantine at write time).
  const chapters: RoadmapCard[] = []
  if (existsSync(directory)) {
    for (const name of readdirSync(directory).sort()) {
      if (!/^\d+-.*\.md$/.test(name) || name.endsWith('.new.md') || name.includes('index')) {
        continue
      }
      try {
        chapters.push(parseCard(readFileSync(join(directory, name), 'utf8')))
      } catch {
        console.warn(`[roadmap] refreshIndex skipping unparseable card: ${name}`)
      }
    }
  }
  const indexCard = buildIndexCard({
    ...args,
    chapters: chapters.length > 0 ? chapters : args.chapters
  })
  writeCard(directory, indexCard)
}
