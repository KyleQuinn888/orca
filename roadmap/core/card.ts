// Roadmap card files: frontmatter serialize/parse, idempotent writes.
// Card identity is {sessionId, chapter.index}; handEdited cards are never
// overwritten (a .new sibling carries the regenerated draft instead).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Evidence } from './anchor'

export type CardTime = { firstTime: string; lastTime: string; durationMin: number; tz?: string }

export type CardSpan = {
  firstMsgSeq: number
  lastMsgSeq: number
  /** S2: human-authored user messages vs all user-role messages. */
  userMsg: { human: number; total: number }
}

export type CardFrontmatter = {
  v: 1
  kind: 'session-chapter'
  source: string
  session: string
  workspace: string
  title: string
  chapter: { index: number; slug: string }
  span: CardSpan
  time: CardTime
  uncovered: string
  schemaNote?: string
  quality: 'agent-draft' | 'approved-baseline'
  handEdited?: boolean
}

export type RoadmapCard = { frontmatter: CardFrontmatter; evidence: Evidence[]; body: string }

export function cardFileName(frontmatter: Pick<CardFrontmatter, 'chapter'>): string {
  return `${String(frontmatter.chapter.index).padStart(2, '0')}-${frontmatter.chapter.slug}.md`
}

export function serializeCard(card: RoadmapCard): string {
  const fm: string[] = ['---']
  const f = card.frontmatter
  fm.push(`v: ${f.v}`, `kind: ${f.kind}`, `source: ${f.source}`, `session: ${f.session}`)
  fm.push(`workspace: ${yamlScalar(f.workspace)}`, `title: ${yamlScalar(f.title)}`)
  fm.push(`chapter:`)
  fm.push(`  index: ${f.chapter.index}`, `  slug: ${f.chapter.slug}`)
  fm.push(`span:`)
  fm.push(
    `  firstMsgSeq: ${f.span.firstMsgSeq}`,
    `  lastMsgSeq: ${f.span.lastMsgSeq}`,
    `  userMsg: { human: ${f.span.userMsg.human}, total: ${f.span.userMsg.total} }`
  )
  fm.push(`time:`)
  fm.push(
    `  firstTime: ${yamlScalar(f.time.firstTime)}`,
    `  lastTime: ${yamlScalar(f.time.lastTime)}`,
    `  durationMin: ${f.time.durationMin}`
  )
  if (f.time.tz) {
    fm.push(`  tz: ${yamlScalar(f.time.tz)}`)
  }
  fm.push(`uncovered: ${yamlScalar(f.uncovered)}`)
  if (f.schemaNote) {
    fm.push(`schemaNote: ${yamlScalar(f.schemaNote)}`)
  }
  fm.push(`quality: ${f.quality}`)
  if (f.handEdited) {
    fm.push(`handEdited: true`)
  }
  fm.push('---', '')
  const evidenceBlock =
    card.evidence.length > 0
      ? ['## 证据锚点', 'evidence:', ...card.evidence.map(serializeEvidence), '']
      : []
  return [...fm, card.body.trimEnd(), '', ...evidenceBlock].join('\n')
}

function serializeEvidence(evidence: Evidence): string {
  const origin =
    evidence.origin.db === 'orca-journal'
      ? `{ db: orca-journal, path: ${evidence.origin.path}, profile: ${evidence.origin.profile} }`
      : `{ db: zcode-tui-sqlite, path: ${evidence.origin.path} }`
  return [
    `  - claim: ${evidence.claim}`,
    `    source: ${evidence.source}`,
    `    origin: ${origin}`,
    `    ref: ${evidence.ref}`,
    `    seq: ${evidence.seq}`,
    `    contentHash: ${evidence.contentHash}`,
    `    hashOf: ${evidence.hashOf}`
  ].join('\n')
}

function yamlScalar(value: string): string {
  return /[:#\n{}[\]]/.test(value) ? `'${value.replace(/'/g, "''")}'` : value
}

export function parseCard(text: string): RoadmapCard {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) {
    throw new Error('card has no frontmatter block')
  }
  const frontmatter = parseFrontmatter(match[1])
  const body = match[2]
  const evidence: Evidence[] = []
  const evidenceMatch = /\n## 证据锚点\nevidence:\n([\s\S]*)$/.exec(body)
  if (evidenceMatch) {
    for (const block of evidenceMatch[1].matchAll(
      /[ \t]*-[ \t]*claim:[ \t]*([^\n]+)\n([\s\S]*?)(?=\n[ \t]*-[ \t]*claim:|$)/g
    )) {
      evidence.push(parseEvidenceBlock(block[1], block[2]))
    }
  }
  return { frontmatter, evidence, body: evidenceMatch ? body.slice(0, evidenceMatch.index) : body }
}

function parseFrontmatter(text: string): CardFrontmatter {
  const values = new Map<string, string>()
  const nested = new Map<string, Map<string, string>>()
  let current: string | null = null
  for (const line of text.split('\n')) {
    const nestedMatch = /^  ([A-Za-z]+): ?(.*)$/.exec(line)
    const topMatch = /^([A-Za-z]+): ?(.*)$/.exec(line)
    if (nestedMatch && current) {
      if (!nested.has(current)) {
        nested.set(current, new Map())
      }
      nested.get(current)!.set(nestedMatch[1], nestedMatch[2])
    } else if (topMatch) {
      values.set(topMatch[1], topMatch[2])
      current = topMatch[1]
    }
  }
  const chapter = nested.get('chapter')
  const span = nested.get('span')
  const time = nested.get('time')
  const userMsg = /\{ human: (\d+), total: (\d+) \}/.exec(span?.get('userMsg') ?? '')
  if (!chapter || !span || !time || !userMsg) {
    throw new Error('card frontmatter missing chapter/span/time')
  }
  return {
    v: 1,
    kind: 'session-chapter',
    source: unscalar(values.get('source') ?? ''),
    session: unscalar(values.get('session') ?? ''),
    workspace: unscalar(values.get('workspace') ?? ''),
    title: unscalar(values.get('title') ?? ''),
    chapter: {
      index: Number(chapter.get('index')),
      slug: chapter.get('slug') ?? ''
    },
    span: {
      firstMsgSeq: Number(span.get('firstMsgSeq')),
      lastMsgSeq: Number(span.get('lastMsgSeq')),
      userMsg: { human: Number(userMsg[1]), total: Number(userMsg[2]) }
    },
    time: {
      firstTime: unscalar(time.get('firstTime') ?? ''),
      lastTime: unscalar(time.get('lastTime') ?? ''),
      durationMin: Number(time.get('durationMin') ?? '0'),
      tz: time.get('tz') ? unscalar(time.get('tz')!) : undefined
    },
    uncovered: unscalar(values.get('uncovered') ?? ''),
    schemaNote: values.get('schemaNote') ? unscalar(values.get('schemaNote')!) : undefined,
    quality: (values.get('quality') as CardFrontmatter['quality']) ?? 'agent-draft',
    handEdited: values.get('handEdited') === 'true'
  }
}

function parseEvidenceBlock(claim: string, rest: string): Evidence {
  const values = new Map<string, string>()
  for (const line of rest.split('\n')) {
    const match = /^    ([A-Za-z]+): ?(.*)$/.exec(line)
    if (match) {
      values.set(match[1], match[2])
    }
  }
  const originRaw = values.get('origin') ?? ''
  const isJournal = originRaw.includes('orca-journal')
  const path = /path: ([^,}]+)/.exec(originRaw)?.[1] ?? ''
  return {
    claim,
    source: (values.get('source') as Evidence['source']) ?? 'zcode-tui-sqlite',
    origin: isJournal
      ? { db: 'orca-journal', path, profile: /profile: ([^,}]+)/.exec(originRaw)?.[1] ?? '' }
      : { db: 'zcode-tui-sqlite', path },
    ref: values.get('ref') ?? '',
    seq: Number(values.get('seq') ?? '0'),
    contentHash: values.get('contentHash') ?? '',
    hashOf: (values.get('hashOf') as Evidence['hashOf']) ?? 'tui-message-data'
  }
}

function unscalar(value: string): string {
  const quoted = /^'(.*)'$/s.exec(value)
  return quoted ? quoted[1].replace(/''/g, "'") : value
}

export type WriteResult =
  | { outcome: 'written'; path: string }
  | { outcome: 'hand-edited-kept'; path: string; draftPath: string }

/** Idempotent atomic write: temp file + rename; handEdited cards keep the original. */
export function writeCard(directory: string, card: RoadmapCard): WriteResult {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, cardFileName(card.frontmatter))
  if (existsSync(path)) {
    const existing = parseCard(readFileSync(path, 'utf8'))
    if (existing.frontmatter.handEdited) {
      const draftPath = `${path.slice(0, -3)}.new.md`
      atomicWrite(draftPath, serializeCard(card))
      return { outcome: 'hand-edited-kept', path, draftPath }
    }
  }
  atomicWrite(path, serializeCard(card))
  return { outcome: 'written', path }
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}
