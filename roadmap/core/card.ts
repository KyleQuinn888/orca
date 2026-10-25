// Roadmap card files — schema v1.1 (reviewed 2026-10-25: dual adversarial
// review verdict REVISE applied). Card identity is {sessionId, chapter.index};
// the FILE name is derived, never the identity. Unparseable cards quarantine
// to .legacy.md instead of poisoning the pipeline.

import type { Evidence } from './anchor'

export { CardParseError, parseCard } from './card-parse'

export type CardKind = 'session-chapter' | 'session-index'
export type CardSource = 'tui-sqlite' | 'orca-journal'
export type CardQuality = 'draft' | 'approved' | 'superseded'
export type CardProvenance = 'llm' | 'heuristic' | 'human'

export type UncoveredRange = { fromSeq: number; toSeq: number; note?: string }

export type CardFrontmatter = {
  v: 1
  kind: CardKind
  source: CardSource
  session: string
  /** TUI: session.directory path. Journal: workspace path (workspaceId carries the Orca id). */
  workspace: string
  workspaceId?: string
  title: string
  /** session-chapter only. */
  chapter?: { index: number; slug: string }
  /** Last covered message = next chapter's firstMsgSeq - 1 (or session end). */
  span: {
    firstMsgSeq: number
    lastMsgSeq: number
    userMsg: { human: number; total: number }
  }
  time: {
    firstTime: string
    lastTime: string
    durationMin: number
    tzOffsetMin: number
    tzNote?: string
  }
  uncovered: UncoveredRange[]
  quality: CardQuality
  provenance: CardProvenance
  supersededBy?: string
  anchorsVerifiedAt?: string
  /** Anchors the S6 gate dropped (rewritten quotes); card keeps only verifiable ones. */
  anchorsDropped?: number
  digestTruncated?: boolean
  handEdited?: boolean
  handEditedAt?: string
  schemaNote?: string
  /** Unknown keys survive a read-modify-write cycle. */
  extra: Record<string, string>
}

export type CardAnchorsDefault = {
  source: CardSource
  origin: { db: string; path: string; profile?: string }
}

export type PitRecord = {
  text: string
  keywords: string[]
  symptom?: string
  fix?: string
  seq?: number
  quote?: string
}

export type RoadmapCard = {
  frontmatter: CardFrontmatter
  anchors: CardAnchorsDefault | null
  evidence: Evidence[]
  /** Structured pits persisted IN the card (second durable store); the
   * project KEYWORDS.md layer rebuilds from these. */
  pits: PitRecord[]
  body: string
}

export function chapterFileName(index: number, slug: string): string {
  return `${String(index).padStart(3, '0')}-${slug}.md`
}

export function serializeCard(card: RoadmapCard): string {
  const f = card.frontmatter
  const lines: string[] = ['---']
  lines.push(`v: ${f.v}`, `kind: ${f.kind}`, `source: ${f.source}`, `session: ${f.session}`)
  lines.push(`workspace: ${scalar(f.workspace)}`)
  if (f.workspaceId) {
    lines.push(`workspaceId: ${f.workspaceId}`)
  }
  lines.push(`title: ${scalar(f.title)}`)
  if (f.chapter) {
    lines.push('chapter:', `  index: ${f.chapter.index}`, `  slug: ${f.chapter.slug}`)
  }
  lines.push(
    'span:',
    `  firstMsgSeq: ${f.span.firstMsgSeq}`,
    `  lastMsgSeq: ${f.span.lastMsgSeq}`,
    `  userMsg: { human: ${f.span.userMsg.human}, total: ${f.span.userMsg.total} }`
  )
  lines.push(
    'time:',
    `  firstTime: ${scalar(f.time.firstTime)}`,
    `  lastTime: ${scalar(f.time.lastTime)}`,
    `  durationMin: ${f.time.durationMin}`,
    `  tzOffsetMin: ${f.time.tzOffsetMin}`
  )
  if (f.time.tzNote) {
    lines.push(`  tzNote: ${scalar(f.time.tzNote)}`)
  }
  lines.push('uncovered:')
  if (f.uncovered.length === 0) {
    lines.pop()
    lines.push('uncovered: []')
  }
  for (const range of f.uncovered) {
    lines.push(
      range.note
        ? `  - { fromSeq: ${range.fromSeq}, toSeq: ${range.toSeq}, note: ${scalar(range.note)} }`
        : `  - { fromSeq: ${range.fromSeq}, toSeq: ${range.toSeq} }`
    )
  }
  lines.push(`quality: ${f.quality}`, `provenance: ${f.provenance}`)
  if (f.supersededBy) {
    lines.push(`supersededBy: ${f.supersededBy}`)
  }
  if (f.anchorsVerifiedAt) {
    lines.push(`anchorsVerifiedAt: ${f.anchorsVerifiedAt}`)
  }
  if (f.anchorsDropped !== undefined) {
    lines.push(`anchorsDropped: ${f.anchorsDropped}`)
  }
  if (f.digestTruncated) {
    lines.push(`digestTruncated: true`)
  }
  if (f.handEdited) {
    lines.push('handEdited: true')
    if (f.handEditedAt) {
      lines.push(`handEditedAt: ${f.handEditedAt}`)
    }
  }
  if (f.schemaNote) {
    lines.push(`schemaNote: ${scalar(f.schemaNote)}`)
  }
  for (const [key, value] of Object.entries(f.extra)) {
    lines.push(`${key}: ${scalar(value)}`)
  }
  lines.push('---', '')
  const blocks: string[] = []
  if (card.evidence.length > 0) {
    blocks.push('## 证据锚点', 'evidence:')
    for (const evidence of card.evidence) {
      blocks.push(serializeEvidence(evidence, card.anchors))
    }
  }
  if ((card.pits ?? []).length > 0) {
    const pitLines: string[] = ['pits:']
    for (const pit of card.pits) {
      pitLines.push(`  - text: ${scalar(pit.text)}`)
      if (pit.keywords.length > 0) {
        pitLines.push(`    keywords: ${scalar(pit.keywords.join('、'))}`)
      }
      if (pit.symptom) {
        pitLines.push(`    symptom: ${scalar(pit.symptom)}`)
      }
      if (pit.fix) {
        pitLines.push(`    fix: ${scalar(pit.fix)}`)
      }
      if (pit.seq !== undefined) {
        pitLines.push(`    seq: ${pit.seq}`)
      }
      if (pit.quote) {
        pitLines.push(`    quote: ${scalar(pit.quote)}`)
      }
    }
    blocks.push(pitLines.join('\n'))
  }
  return [
    ...lines,
    ...(card.anchors ? anchorsLines(card.anchors) : []),
    card.body.trimEnd(),
    '',
    blocks.flat().join('\n'),
    ''
  ].join('\n')
}

function inlineOrigin(origin: CardAnchorsDefault['origin']): string {
  const parts = [`db: ${origin.db}`, `path: ${origin.path}`]
  if (origin.profile) {
    parts.push(`profile: ${origin.profile}`)
  }
  return `{ ${parts.join(', ')} }`
}

function anchorsLines(anchors: CardAnchorsDefault): string[] {
  return [
    'anchors:',
    `  source: ${anchors.source}`,
    `  origin: ${inlineOrigin(anchors.origin)}`,
    ''
  ]
}

function serializeEvidence(evidence: Evidence, defaults: CardAnchorsDefault | null): string {
  const lines = [`  - claim: ${evidence.claim}`]
  const skipSource =
    defaults !== null &&
    defaults.source === evidence.source &&
    JSON.stringify(defaults.origin) === JSON.stringify(evidence.origin)
  if (!skipSource) {
    lines.push(
      `    source: ${evidence.source}`,
      `    origin: ${inlineOrigin({ ...evidence.origin, db: evidence.origin.db })}`
    )
  }
  lines.push(`    ref: ${evidence.ref}`, `    seq: ${evidence.seq}`)
  if (evidence.quote) {
    lines.push(`    quote: ${scalar(evidence.quote)}`)
  }
  lines.push(`    contentHash: ${evidence.contentHash}`, `    hashOf: ${evidence.hashOf}`)
  return lines.join('\n')
}

function scalar(value: string): string {
  if (/[\n]/.test(value)) {
    throw new Error(`multi-line value not representable in v1.1 scalars: ${value.slice(0, 40)}`)
  }
  // Quote on any structural or comment-trigger character, not just leading
  // ones: a mid-string ": " or " #" would corrupt line-based parsing.
  const needsQuotes =
    /^[:{}[\],&*?|'%@`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^(true|false|null|~)$/.test(value) ||
    value.includes(': ') ||
    value.includes(' #') ||
    value.includes(':')
  return needsQuotes ? `'${value.replace(/'/g, "''")}'` : value
}

export { writeCard, type WriteResult } from './card-io'
