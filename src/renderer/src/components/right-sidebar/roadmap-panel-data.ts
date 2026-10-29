// Parsers for the on-disk roadmap layers (`.roadmap/` schema v1.1). The panel
// only READS: session groups come from each session's `000-index.md` table, the
// pits view from the derived `.roadmap/pits/KEYWORDS.md`, and the project view
// from `.roadmap/INDEX.md`. All parsers are total — a malformed row or missing
// column is skipped, never thrown, so one bad card cannot blank the panel.

import { resolveRuntimePath } from '../../../../shared/cross-platform-path'

export type RoadmapChapterRow = {
  index: number
  slug: string
  title: string
  /** Rendered span cell, e.g. "seq 12–34". */
  seqRange: string
  human: string
  time: string
  /** quality/provenance cell, e.g. "draft/llm". */
  status: string
  source: string
  fileName: string
}

export type RoadmapSessionGroup = {
  sessionId: string
  title: string
  chapters: RoadmapChapterRow[]
}

export type RoadmapPitRow = {
  keywords: string
  /** symptom → fix cell, or the raw pit text when unstructured. */
  resolution: string
  sourceLabel: string
  /** Markdown link target relative to the KEYWORDS.md directory, when present. */
  sourceHref: string | null
  /** Trailing text after the link, e.g. "seq 42". */
  sourceDetail: string
  verified: boolean
  /** v2 pit-id (pit-xxxxxx), used to locate the full entry in DETAILS.md */
  pitId: string | null
}

export type RoadmapPitSection = {
  sessionId: string
  title: string
  rows: RoadmapPitRow[]
}

export type RoadmapMilestone = {
  title: string
  /** Non-empty body lines below the heading, table separators stripped. */
  lines: string[]
}

/** Split a markdown table row into unescaped cells; null when not a row. */
function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return null
  }
  const cells: string[] = []
  let cell = ''
  for (let i = 1; i < trimmed.length - 1; i++) {
    const char = trimmed[i]
    if (char === '\\' && trimmed[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (char === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}

function isTableSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

/** Scalar frontmatter value (`key: value`), single quotes unwrapped. */
function parseFrontmatterScalar(content: string, key: string): string | null {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(content)
  if (!match) {
    return null
  }
  let value = match[1].trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * Parse a session's `000-index.md`: frontmatter carries the session identity,
 * the table carries one row per chapter (renderer of `renderIndexBody`).
 */
export function parseSessionIndex(content: string): RoadmapSessionGroup | null {
  const sessionId = parseFrontmatterScalar(content, 'session')
  if (!sessionId) {
    return null
  }
  const title = parseFrontmatterScalar(content, 'title') ?? sessionId
  const chapters: RoadmapChapterRow[] = []
  for (const line of content.split('\n')) {
    const cells = splitTableRow(line)
    if (!cells || cells.length < 8 || isTableSeparatorRow(cells)) {
      continue
    }
    const index = Number(cells[0])
    if (!Number.isInteger(index) || index < 0) {
      continue
    }
    const slug = cells[1]
    chapters.push({
      index,
      slug,
      title: cells[2] || slug,
      seqRange: cells[3],
      human: cells[4],
      time: cells[5],
      status: cells[6],
      source: cells[7],
      fileName: `${String(index).padStart(3, '0')}-${slug}.md`
    })
  }
  return { sessionId, title, chapters }
}

/**
 * Parse `.roadmap/pits/KEYWORDS.md`: `## <sessionId> <title>` sections whose
 * tables are `| keywords | symptom → fix | source | verified |`.
 */
export function parsePitsKeywords(content: string): RoadmapPitSection[] {
  const sections: RoadmapPitSection[] = []
  let current: RoadmapPitSection | null = null
  for (const line of content.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line.trim())
    if (heading) {
      const raw = heading[1].trim()
      const firstSpace = raw.indexOf(' ')
      current =
        firstSpace === -1
          ? { sessionId: raw, title: raw, rows: [] }
          : {
              sessionId: raw.slice(0, firstSpace),
              title: raw.slice(firstSpace + 1).trim() || raw.slice(0, firstSpace),
              rows: []
            }
      sections.push(current)
      continue
    }
    // v2 pits-index has no ## session headings — the table sits directly
    // under the # title. Fall back to a single unnamed section.
    if (!current && line.trim().startsWith('|')) {
      current = { sessionId: '', title: '全部坑', rows: [] }
      sections.push(current)
    }
    if (!current) {
      continue
    }
    const cells = splitTableRow(line)
    if (!cells || cells.length < 4 || isTableSeparatorRow(cells)) {
      continue
    }
    // v2 format: | pit-id | keywords | symptom | reproduction |
    // v1 format: | keywords | resolution | source | verified |
    const isV2 = /^pit-[0-9a-f]{6,}$/.test(cells[0])
    if (isV2) {
      current.rows.push({
        keywords: cells[1],
        resolution: cells[2],
        sourceLabel: cells[0],
        sourceHref: null,
        sourceDetail: cells[3],
        verified: false,
        pitId: cells[0]
      })
    } else {
      const source = parsePitSource(cells[2])
      current.rows.push({
        keywords: cells[0],
        resolution: cells[1],
        sourceLabel: source.label,
        sourceHref: source.href,
        sourceDetail: source.detail,
        verified: cells[3] === '✓',
        pitId: null
      })
    }
  }
  return sections.filter((section) => section.rows.length > 0)
}

function parsePitSource(cell: string): {
  label: string
  href: string | null
  detail: string
} {
  const link = /^\[([^\]]*)\]\(([^)]*)\)(.*)$/.exec(cell)
  if (!link) {
    return { label: cell, href: null, detail: '' }
  }
  return {
    label: link[1],
    href: link[2] || null,
    detail: link[3].trim()
  }
}

/**
 * Parse `.roadmap/INDEX.md` (003 project layer): `##` headings are milestones,
 * the non-empty lines below each are its body. Tolerant by design — the layer's
 * format is still settling, so the panel renders whatever prose is there.
 */
export function parseProjectIndex(content: string): RoadmapMilestone[] {
  const milestones: RoadmapMilestone[] = []
  let current: RoadmapMilestone | null = null
  for (const line of content.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line.trim())
    if (heading) {
      current = { title: heading[1].trim(), lines: [] }
      milestones.push(current)
      continue
    }
    if (!current) {
      continue
    }
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const cells = splitTableRow(trimmed)
    if (cells && isTableSeparatorRow(cells)) {
      continue
    }
    current.lines.push(trimmed)
  }
  return milestones.filter((milestone) => milestone.lines.length > 0 || milestone.title)
}

/** Resolve a KEYWORDS.md relative link target against the pits directory. */
export function resolvePitSourcePath(pitsDir: string, href: string): string {
  return resolveRuntimePath(pitsDir, href.replace(/\\/g, '/'))
}
