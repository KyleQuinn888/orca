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
import { writeCard } from './core/card'
import { refreshIndex } from './core/index-card'
import { rebuildPitsIndex } from './core/pits-index'
import { renderCard } from './core/render'
import { establishedTerms, lintTerms, termInjectionHeader } from './core/term-consistency'
import { summarizeChapter, type SummarizedChapter } from './core/summarizer'
import { verifyEvidence } from './core/anchor'

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
  const verifiedSeqs = new Set<number>()
  for (const window of chosen) {
    window.userMsg.total = countUserRole(session, window)
    const { digest, truncated } = buildDigest(session, window)
    const termHeader = termInjectionHeader(establishedTerms(outRoot))
    const digestWithTerms = `${termHeader}${digest}`
    const result = args.noLlm
      ? { kind: 'heuristic' as const, card: heuristicFrom(session, window), reason: '--no-llm' }
      : await summarizeChapter({ digest: digestWithTerms, promptTemplate })
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
    for (const evidence of card.evidence) {
      verifiedSeqs.add(evidence.seq)
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
    // Structured pits persist IN the card (second durable store); the project
    // KEYWORDS.md rebuilds from cards, so partial rebuilds cannot lose rows.
    card.pits = result.card.pitfalls.map((pit) => ({
      text: pit.text,
      keywords: pit.keywords ?? [],
      symptom: pit.symptom,
      fix: pit.fix,
      seq: pit.seq
    }))
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
  // Pits layer is fully derived from cards on disk: rebuild covers sessions
  // this run never touched, and repeated runs are idempotent. --out redirects
  // the rebuild root so dry runs never touch the real project tree.
  const termConflicts = lintTerms(outRoot)
  if (termConflicts.length > 0) {
    console.warn(`[roadmap] 术语漂移 lint（非阻断，建议统一后重生成对应章）：`)
    for (const conflict of termConflicts) {
      console.warn(
        `  「${conflict.jargon}」→ ${conflict.renderings.join(' / ')}（Ch.${conflict.chapters.join(', ')}）`
      )
    }
  }
  const pitsRoot = args.out
    ? args.out.slice(0, args.out.lastIndexOf(join('.roadmap', '001')))
    : session.directory
  if (pitsRoot) {
    const pitsPath = rebuildPitsIndex(pitsRoot, verifiedSeqs)
    if (pitsPath) {
      console.log(`pits layer rebuilt: ${pitsPath}`)
    } else {
      console.log('pits layer: no structured pits on disk, nothing written')
    }
  }
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
