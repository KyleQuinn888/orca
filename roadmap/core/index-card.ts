// S1 session index card: the always-resident layer (~1k tokens/session).
// Chapter cards are pulled on demand; this card lists them plus the
// session-level uncovered ledger (S5).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cardFileName, parseCard, writeCard, type RoadmapCard } from './card'

export type IndexRow = {
  index: number
  slug: string
  title: string
  span: { firstMsgSeq: number; lastMsgSeq: number; human: number }
  time: { firstTime: string; lastTime: string }
  quality: string
}

export function buildIndexCard(args: {
  source: string
  session: string
  workspace: string
  title: string
  chapters: RoadmapCard[]
  sessionUncovered: string
}): RoadmapCard {
  const first = args.chapters.at(0)
  const last = args.chapters.at(-1)
  return {
    frontmatter: {
      v: 1,
      kind: 'session-chapter' as const,
      source: args.source,
      session: args.session,
      workspace: args.workspace,
      title: args.title,
      chapter: { index: 0, slug: 'index' },
      span: first
        ? {
            firstMsgSeq: first.frontmatter.span.firstMsgSeq,
            lastMsgSeq: last.frontmatter.span.lastMsgSeq,
            userMsg: {
              human: args.chapters.reduce((n, c) => n + c.frontmatter.span.userMsg.human, 0),
              total: args.chapters.reduce((n, c) => n + c.frontmatter.span.userMsg.total, 0)
            }
          }
        : { firstMsgSeq: 0, lastMsgSeq: 0, userMsg: { human: 0, total: 0 } },
      time: first
        ? {
            firstTime: first.frontmatter.time.firstTime,
            lastTime: last.frontmatter.time.lastTime,
            durationMin: args.chapters.reduce((n, c) => n + c.frontmatter.time.durationMin, 0)
          }
        : { firstTime: '', lastTime: '', durationMin: 0 },
      uncovered: args.sessionUncovered,
      quality: 'agent-draft'
    },
    evidence: [],
    body: renderIndexBody(args.chapters)
  }
}

function renderIndexBody(chapters: RoadmapCard[]): string {
  const lines = [
    '# 会话索引',
    '',
    '| Ch | 标题 | 区间 | 人工消息 | 时间 | 状态 |',
    '|---|---|---|---|---|---|'
  ]
  for (const card of chapters) {
    const heading = /^#\s+(.+)$/m.exec(card.body)
    const f = card.frontmatter
    lines.push(
      `| ${f.chapter.index} | ${heading?.[1] ?? f.chapter.slug} | seq ${f.span.firstMsgSeq}–${f.span.lastMsgSeq} | ${f.span.userMsg.human} | ${f.time.firstTime.slice(0, 16)} | ${f.quality} |`
    )
  }
  return lines.join('\n')
}

export function refreshIndex(directory: string, args: Parameters<typeof buildIndexCard>[0]): void {
  // Re-scan chapter cards from disk so the index reflects reality, not memory.
  const chapters: RoadmapCard[] = []
  if (existsSync(directory)) {
    const names = readdirSync(directory)
      .filter((n) => /^\d{2}-.*\.md$/.test(n) && !n.endsWith('.new.md') && n !== '00-index.md')
      .sort()
    for (const name of names) {
      chapters.push(parseCard(readFileSync(join(directory, name), 'utf8')))
    }
  }
  const indexCard = buildIndexCard({
    ...args,
    chapters: chapters.length > 0 ? chapters : args.chapters
  })
  writeCard(directory, indexCard)
}

export { cardFileName }
