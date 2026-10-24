// roadmap build CLI — SessionRoadMap Approach A slice.
//   bun roadmap/build.ts <sessionId> [--source tui|journal] [--profile orca|orca-dev]
//                        [--chapter N] [--list] [--no-llm] [--out <dir>]
// Writes .roadmap/001/<sessionId>/<nn>-<slug>.md cards + refreshes the S1 index card.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SourceLocationError, locateSource, openTui } from './core/sources'
import {
  buildDigest,
  countUserRole,
  proposeChapterWindows,
  readTuiSession
} from './core/tui-reader'
import { serializeCard, writeCard, type CardFrontmatter, type RoadmapCard } from './core/card'
import { refreshIndex } from './core/index-card'
import { summarizeChapter } from './core/summarizer'

const args = parseArgs(process.argv.slice(2))
const promptTemplate = readFileSync(join(import.meta.dir, 'prompts', 'task-node.md'), 'utf8')

async function main(): Promise<void> {
  if (!args.sessionId) {
    console.error(
      'usage: bun roadmap/build.ts <sessionId> [--source tui|journal] [--profile orca|orca-dev] [--chapter N] [--list] [--no-llm] [--out <dir>]'
    )
    process.exit(2)
  }
  const source = locateSource({ source: args.source, profile: args.profile })
  if (source.kind !== 'tui') {
    console.error(
      `journal-source chapters land with the R1 service; this slice reads TUI sessions (got ${source.profile})`
    )
    process.exit(2)
  }
  const { db, path } = openTui()
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
  for (const window of chosen) {
    window.userMsg.total = countUserRole(session, window)
    const { digest, truncated } = buildDigest(session, window)
    const result = args.noLlm
      ? { kind: 'heuristic' as const, card: heuristicFrom(session, window), reason: '--no-llm' }
      : await summarizeChapter({ digest, promptTemplate })
    const card = renderCard(session, window, result, truncated, path)
    const written = writeCard(outRoot, card)
    console.log(
      `${written.outcome}: ${written.path}${written.outcome === 'hand-edited-kept' ? ` (draft: ${written.draftPath})` : ''} [${result.kind}]`
    )
  }
  refreshIndex(outRoot, {
    source: 'zcode-tui-sqlite',
    session: session.id,
    workspace: session.directory,
    title: session.title,
    chapters: [],
    sessionUncovered:
      windows.length > 0 ? `共 ${windows.length} 章；未切章区间见各章 uncovered` : '整会话未切章'
  })
  console.log(`index refreshed: ${join(outRoot, '00-index.md')}`)
}

function renderCard(
  session: ReturnType<typeof readTuiSession>,
  window: ReturnType<typeof proposeChapterWindows>[number],
  result: {
    kind: string
    card: {
      title: string
      points: string[]
      decisions: string[]
      artifacts: string[]
      pitfalls: string[]
    }
    reason?: string
  },
  truncated: boolean,
  dbPath: string
): RoadmapCard {
  const frontmatter: CardFrontmatter = {
    v: 1,
    kind: 'session-chapter',
    source: 'zcode-tui-sqlite',
    session: session.id,
    workspace: session.directory,
    title: session.title,
    chapter: { index: window.index, slug: slugify(result.card.title) },
    span: window,
    time: {
      firstTime: window.firstTime,
      lastTime: window.lastTime,
      durationMin: window.durationMin,
      tz: 'UTC，当地=UTC+8'
    },
    uncovered: truncated
      ? `digest 超限截断：本区间尾部部分消息未进入总结；会话其余章节见 00-index.md`
      : `其余章节见 00-index.md；未切章区间见索引`,
    schemaNote: `zcode TUI SQLite (${dbPath})，message.data schema 见会话首页说明`,
    quality: 'agent-draft'
  }
  const body = [
    `# Ch.${window.index} ${result.card.title}${result.kind === 'heuristic' ? '（启发式降级）' : ''}`,
    result.reason && result.kind === 'heuristic' ? `> 降级原因：${result.reason}\n` : '',
    '## 要点',
    ...result.card.points.map((p) => `- ${p}`),
    '',
    '## 关键决策',
    ...(result.card.decisions.length > 0 ? result.card.decisions.map((d) => `- ${d}`) : ['- 无']),
    '',
    '## 涉及文件/产物',
    ...(result.card.artifacts.length > 0 ? result.card.artifacts.map((a) => `- ${a}`) : ['- 无']),
    '',
    '## 坑',
    ...(result.card.pitfalls.length > 0 ? result.card.pitfalls.map((p) => `- ${p}`) : ['- 本段无'])
  ].join('\n')
  return { frontmatter, evidence: [], body }
}

function heuristicFrom(
  session: ReturnType<typeof readTuiSession>,
  window: ReturnType<typeof proposeChapterWindows>[number]
) {
  const humans = session.messages.filter(
    (m) => m.human && m.seq >= window.firstMsgSeq && m.seq <= window.lastMsgSeq
  )
  return {
    title: `${session.title.slice(0, 30)}（区间摘要待生成）`,
    points: humans
      .slice(0, 5)
      .map((m) => `**用户输入摘录（seq ${m.seq}）**。${m.texts.join(' ').slice(0, 100)}…`),
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
  profile?: 'orca' | 'orca-dev'
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
    } else if (arg === '--profile') {
      parsed.profile = argv[++i] as 'orca' | 'orca-dev'
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

export { serializeCard }
