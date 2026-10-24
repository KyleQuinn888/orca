// Card parsing — split from card.ts (max-lines ratchet: no exemptions).
// Fail-closed per v1.1 review: unknown version rejected, missing required
// fields rejected, unknown keys preserved in extra, CRLF normalized.

import type { CardAnchorsDefault, CardFrontmatter, CardSource, UncoveredRange } from './card'
import type { Evidence } from './anchor'
import type { RoadmapCard } from './card'

export class CardParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardParseError'
  }
}

export function parseCard(text: string): RoadmapCard {
  // CRLF is the norm on Windows hand edits; normalize before line parsing.
  const normalized = text.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized)
  if (!match) {
    throw new CardParseError('card has no frontmatter block')
  }
  const frontmatter = parseFrontmatter(match[1])
  const body = match[2]
  const anchors: CardAnchorsDefault | null =
    /^\n?anchors:\n  source: (\S+)\n  origin: \{ (.+) \}/.test(body)
      ? parseAnchorsBlock(body)
      : null
  const evidence: Evidence[] = []
  const evidenceMatch = /\n## 证据锚点\nevidence:\n([\s\S]*)$/.exec(body)
  if (evidenceMatch) {
    for (const block of evidenceMatch[1].matchAll(
      /[ \t]*-[ \t]*claim:[ \t]*([^\n]+)\n([\s\S]*?)(?=\n[ \t]*-[ \t]*claim:|$)/g
    )) {
      evidence.push(parseEvidenceBlock(block[1], block[2]))
    }
  }
  return {
    frontmatter,
    anchors,
    evidence,
    body: evidenceMatch ? body.slice(0, evidenceMatch.index) : body
  }
}

function parseAnchorsBlock(body: string): CardAnchorsDefault | null {
  const match = /^\n?anchors:\n  source: (\S+)\n  origin: \{ (.+) \}/.exec(body)
  if (!match) {
    return null
  }
  const origin: CardAnchorsDefault['origin'] = { db: '', path: '' }
  for (const part of splitTop(match[2])) {
    const [key, value] = splitKeyValue(part)
    if (key === 'db') {
      origin.db = value
    } else if (key === 'path') {
      origin.path = value
    } else if (key === 'profile') {
      origin.profile = value
    }
  }
  return { source: match[1] as CardSource, origin }
}

function parseFrontmatter(text: string): CardFrontmatter {
  const values = new Map<string, string>()
  const nested = new Map<string, Map<string, string>>()
  const listKeys = new Map<string, string[]>()
  const known = new Set([
    'v',
    'kind',
    'source',
    'session',
    'workspace',
    'workspaceId',
    'title',
    'chapter',
    'span',
    'time',
    'uncovered',
    'quality',
    'provenance',
    'supersededBy',
    'anchorsVerifiedAt',
    'anchorsDropped',
    'digestTruncated',
    'handEdited',
    'handEditedAt',
    'schemaNote'
  ])
  let current: string | null = null
  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine)
    const listItem = /^  - (.+)$/.exec(line)
    const nestedMatch = /^  ([A-Za-z]+): ?(.*)$/.exec(line)
    const topMatch = /^([A-Za-z-]+): ?(.*)$/.exec(line)
    if (listItem && current === 'uncovered') {
      if (!listKeys.has('uncovered')) {
        listKeys.set('uncovered', [])
      }
      listKeys.get('uncovered')!.push(listItem[1])
    } else if (nestedMatch && current) {
      if (!nested.has(current)) {
        nested.set(current, new Map())
      }
      nested.get(current)!.set(nestedMatch[1], nestedMatch[2].trim())
    } else if (topMatch) {
      values.set(topMatch[1], topMatch[2].trim())
      current = topMatch[1]
    } else if (line.trim().length > 0) {
      throw new CardParseError(`unparseable frontmatter line: ${rawLine.slice(0, 50)}`)
    }
  }
  const version = values.get('v')
  if (version === undefined) {
    throw new CardParseError('card has no v field')
  }
  if (version !== '1') {
    throw new CardParseError(`unsupported card version v:${version} (this build reads v:1 only)`)
  }
  const chapter = nested.get('chapter')
  const span = nested.get('span')
  const time = nested.get('time')
  if (!span || !time) {
    throw new CardParseError('card frontmatter missing span/time')
  }
  const userMsg = /\{ human: (\d+), total: (\d+) \}/.exec(span.get('userMsg') ?? '')
  if (!userMsg) {
    throw new CardParseError('span.userMsg missing or malformed (required since v1.1)')
  }
  const uncovered = parseUncovered(listKeys.get('uncovered') ?? [], values.get('uncovered'))
  const kind = requireEnum(values, 'kind', ['session-chapter', 'session-index'])
  if (kind === 'session-chapter' && !chapter) {
    throw new CardParseError('session-chapter requires chapter block')
  }
  const extra: Record<string, string> = {}
  for (const [key, value] of values) {
    if (!known.has(key)) {
      extra[key] = unscalar(value)
    }
  }
  return {
    v: 1,
    kind,
    source: requireEnum(values, 'source', ['tui-sqlite', 'orca-journal']),
    session: unscalar(requireKey(values, 'session')),
    workspace: unscalar(requireKey(values, 'workspace')),
    workspaceId: values.get('workspaceId') ? unscalar(values.get('workspaceId')!) : undefined,
    title: unscalar(requireKey(values, 'title')),
    chapter: chapter
      ? { index: Number(chapter.get('index')), slug: chapter.get('slug') ?? '' }
      : undefined,
    span: {
      firstMsgSeq: Number(span.get('firstMsgSeq')),
      lastMsgSeq: Number(span.get('lastMsgSeq')),
      userMsg: { human: Number(userMsg[1]), total: Number(userMsg[2]) }
    },
    time: {
      firstTime: unscalar(time.get('firstTime') ?? ''),
      lastTime: unscalar(time.get('lastTime') ?? ''),
      durationMin: Number(time.get('durationMin') ?? '0'),
      tzOffsetMin: Number(time.get('tzOffsetMin') ?? '0'),
      tzNote: time.get('tzNote') ? unscalar(time.get('tzNote')!) : undefined
    },
    uncovered,
    quality: requireEnum(values, 'quality', ['draft', 'approved', 'superseded']),
    provenance: requireEnum(values, 'provenance', ['llm', 'heuristic', 'human']),
    supersededBy: values.get('supersededBy'),
    anchorsVerifiedAt: values.get('anchorsVerifiedAt'),
    anchorsDropped: values.get('anchorsDropped') ? Number(values.get('anchorsDropped')) : undefined,
    digestTruncated: values.get('digestTruncated') === 'true',
    handEdited: values.get('handEdited') === 'true',
    handEditedAt: values.get('handEditedAt'),
    schemaNote: values.get('schemaNote') ? unscalar(values.get('schemaNote')!) : undefined,
    extra
  }
}

function parseUncovered(items: string[], inline: string | undefined): UncoveredRange[] {
  if (items.length > 0) {
    return items.map((item) => parseRange(item))
  }
  if (inline !== undefined && inline.trim() !== '' && inline.trim() !== '[]') {
    return [parseRange(inline.trim())]
  }
  return []
}

function parseRange(item: string): UncoveredRange {
  const match = /^\{ fromSeq: (\d+), toSeq: (\d+)(?:, note: (.*))? \}$/.exec(item)
  if (!match) {
    throw new CardParseError(`uncovered range malformed: ${item.slice(0, 50)}`)
  }
  return {
    fromSeq: Number(match[1]),
    toSeq: Number(match[2]),
    note: match[3] ? unscalar(match[3]) : undefined
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
  if (!values.get('hashOf')) {
    throw new CardParseError(
      `evidence for "${claim.slice(0, 20)}" has no hashOf (required since v1.1)`
    )
  }
  const originRaw = values.get('origin') ?? ''
  const isJournal = originRaw.includes('orca-journal')
  const path = extractOriginField(originRaw, 'path')
  const profile = extractOriginField(originRaw, 'profile')
  return {
    claim,
    source:
      (values.get('source') as Evidence['source']) ?? (isJournal ? 'orca-journal' : 'tui-sqlite'),
    origin: isJournal ? { db: 'orca-journal', path, profile } : { db: 'tui-sqlite', path },
    ref: values.get('ref') ?? '',
    seq: Number(values.get('seq') ?? '0'),
    quote: values.get('quote') ? unscalar(values.get('quote')!) : undefined,
    contentHash: values.get('contentHash') ?? '',
    hashOf: values.get('hashOf') as Evidence['hashOf']
  }
}

function extractOriginField(originRaw: string, field: string): string {
  const match = new RegExp(`${field}: ([^,}]+)`).exec(originRaw)
  return match ? unscalar(match[1].trim()) : ''
}

function splitTop(text: string): string[] {
  return text.split(', ')
}

function splitKeyValue(part: string): [string, string] {
  const index = part.indexOf(': ')
  return [part.slice(0, index), unscalar(part.slice(index + 2))]
}

/** Strips ` # comment` outside single-quoted scalars. */
function stripComment(line: string): string {
  const quoteStart = line.indexOf("'")
  const hash = line.indexOf(' #')
  if (hash === -1) {
    return line
  }
  if (quoteStart === -1 || hash < quoteStart) {
    return line.slice(0, hash)
  }
  return line
}

function requireKey(values: Map<string, string>, key: string): string {
  const value = values.get(key)
  if (value === undefined) {
    throw new CardParseError(`card frontmatter missing ${key}`)
  }
  return value
}

function requireEnum<T extends string>(
  values: Map<string, string>,
  key: string,
  allowed: readonly T[]
): T {
  const value = requireKey(values, key)
  if (!allowed.includes(value as T)) {
    throw new CardParseError(`${key}=${value} not in [${allowed.join(', ')}]`)
  }
  return value as T
}

function unscalar(value: string): string {
  const quoted = /^'(.*)'$/s.exec(value)
  return quoted ? quoted[1].replace(/''/g, "'") : value
}

export type WriteResult =
  | { outcome: 'written'; path: string }
  | { outcome: 'hand-edited-kept'; path: string; draftPath: string }
