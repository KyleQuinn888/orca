// Roadmap card files — schema v1.1 (reviewed 2026-10-25: dual adversarial
// review verdict REVISE applied). Card identity is {sessionId, chapter.index};
// the FILE name is derived, never the identity. Unparseable cards quarantine
// to .legacy.md instead of poisoning the pipeline.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { Evidence } from './anchor'
import { CardParseError, parseCard } from './card-parse'

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

export type RoadmapCard = {
  frontmatter: CardFrontmatter
  anchors: CardAnchorsDefault | null
  evidence: Evidence[]
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

export type WriteResult =
  | { outcome: 'written'; path: string }
  | { outcome: 'hand-edited-kept'; path: string; draftPath: string }
  | { outcome: 'legacy-quarantined'; path: string; legacyPath: string }

/**
 * Idempotent atomic write by {sessionId, chapter.index}: stale same-index
 * files with a different slug are removed (filename is derived, not identity),
 * handEdited cards keep the original (.new.md draft), unparseable cards
 * quarantine to .legacy.md instead of aborting the pipeline.
 */
export function writeCard(directory: string, card: RoadmapCard): WriteResult {
  mkdirSync(directory, { recursive: true })
  const f = card.frontmatter
  const isIndex = f.kind === 'session-index'
  const wanted = isIndex
    ? '000-index.md'
    : chapterFileName(f.chapter?.index ?? 0, f.chapter?.slug ?? 'untitled')
  const path = join(directory, wanted)
  let quarantined: string | null = null
  for (const name of readdirSync(directory)) {
    if (name === wanted || (!name.endsWith('.md') && !name.endsWith('.new.md'))) {
      continue
    }
    if (
      isIndex ? name === '00-index.md' || name.endsWith('-index.md') : sameIndexFile(name, wanted)
    ) {
      const existingPath = join(directory, name)
      if (name.endsWith('.legacy.md') || name.endsWith('.superseded.md')) {
        continue
      }
      let existingText: string
      try {
        existingText = readFileSync(existingPath, 'utf8')
      } catch {
        continue
      }
      try {
        const existing = parseCard(existingText)
        if (!isIndex && existing.frontmatter.handEdited) {
          const draftPath = `${path.slice(0, -3)}.new.md`
          atomicWrite(draftPath, serializeCard(card))
          return { outcome: 'hand-edited-kept', path: existingPath, draftPath }
        }
        if (existing.frontmatter.kind !== 'session-index') {
          renameSync(existingPath, `${existingPath.slice(0, -3)}.superseded.md`)
        }
      } catch (error) {
        if (error instanceof CardParseError) {
          renameSync(existingPath, `${existingPath.slice(0, -3)}.legacy.md`)
          quarantined = `${name}.legacy.md`
          console.warn(
            `[roadmap] quarantined unparseable card to ${name}.legacy.md: ${error.message}`
          )
        } else {
          throw error
        }
      }
    }
  }
  if (existsSync(path)) {
    const existing = parseCard(readFileSync(path, 'utf8'))
    if (!isIndex && existing.frontmatter.handEdited) {
      const draftPath = `${path.slice(0, -3)}.new.md`
      atomicWrite(draftPath, serializeCard(card))
      return { outcome: 'hand-edited-kept', path, draftPath }
    }
  }
  atomicWrite(path, serializeCard(card))
  if (quarantined !== null) {
    return { outcome: 'legacy-quarantined', path, legacyPath: quarantined }
  }
  return { outcome: 'written', path }
}

function sameIndexFile(name: string, wanted: string): boolean {
  // Compare numerically: v1 files used 2-digit padding, v1.1 uses 3.
  const wantedMatch = /^(\d+)-.*\.md$/.exec(wanted)
  const nameMatch = /^(\d+)-.*\.md$/.exec(name)
  return (
    wantedMatch !== null && nameMatch !== null && Number(wantedMatch[1]) === Number(nameMatch[1])
  )
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}
