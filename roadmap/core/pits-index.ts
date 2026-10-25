// Project-level pit layer, two files (spec agent-retrieval v1.4):
//   .roadmap/pits/KEYWORDS.md — bounded scan index (keyword-set identity,
//     cross-session recurrence K, capped window, whole-row boundaries)
//   .roadmap/pits/DETAILS.md  — full rows with inline pit-id anchors, never
//     truncated, per-session sections; the grep channel for error-rescan
// Fully derived: rebuilt from every session's chapter cards on disk. The
// verification mark is PERSISTENT (card anchorsVerifiedAt + evidence seqs),
// not a per-run set — fixing the regression where a new session's build
// flipped older sessions' pits back to unverified.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { escapeCell, isChapterCardFile } from './chapter-files'
import {
  canonicalKeywords,
  countCodePoints,
  pitIdOf,
  symptomOneLiner,
  unionCell
} from './pit-cells'
import { parseCard } from './card'

export { canonicalKeywords, pitIdOf, symptomOneLiner, unionCell } from './pit-cells'

export const INDEX_MAX_ROWS = 40
export const INDEX_MAX_CODE_POINTS = 2400
const DETAILS_CELL_MAX = 2000

export type PitRow = {
  session: string
  chapter: number
  slug: string
  seq?: number
  keywords: string[]
  symptom?: string
  fix?: string
  text: string
  verified: boolean
  pitId: string
  cardFile: string
  /** ISO lastTime of the pit's chapter card (occurrence time for ordering). */
  cardLastTime: string
}

/** Collect every pit occurrence from all cards, with persistent verification. */
function collectRows(root: string): PitRow[] {
  const sessionsDir = join(root, '.roadmap', '001')
  if (!existsSync(sessionsDir)) {
    return []
  }
  const rows: PitRow[] = []
  for (const sessionId of readdirSync(sessionsDir).sort()) {
    const sessionDir = join(sessionsDir, sessionId)
    if (!existsSync(sessionDir)) {
      continue
    }
    for (const name of readdirSync(sessionDir).sort()) {
      if (!isChapterCardFile(name)) {
        continue
      }
      try {
        const card = parseCard(readFileSync(join(sessionDir, name), 'utf8'))
        const fm = card.frontmatter
        const chapter = fm.chapter?.index ?? 0
        const slug = fm.chapter?.slug ?? ''
        const evidenceSeqs = new Set(card.evidence.map((e) => e.seq))
        for (const pit of card.pits) {
          // empty keyword lists fall back to a text prefix so id/display stay consistent
          const keywords = pit.keywords.length > 0 ? pit.keywords : [pit.text.slice(0, 12)]
          rows.push({
            session: sessionId,
            chapter,
            slug,
            seq: pit.seq,
            keywords,
            symptom: pit.symptom,
            fix: pit.fix,
            text: pit.text,
            // persistent verification: card stamp + this pit's seq survives in evidence
            verified:
              Boolean(fm.anchorsVerifiedAt) && pit.seq !== undefined && evidenceSeqs.has(pit.seq),
            pitId: pitIdOf(pit.keywords.length > 0 ? pit.keywords : [pit.text.slice(0, 12)]),
            cardFile: name,
            cardLastTime: fm.time?.lastTime ?? ''
          })
        }
      } catch {
        console.warn(`[roadmap] rebuildPitsIndex skipping unparseable card: ${sessionId}/${name}`)
      }
    }
  }
  return rows
}

/** Session section ordering: min-index card firstTime asc, tie by session dirname. */
function sessionFirstTimes(root: string): Map<string, string> {
  const sessionsDir = join(root, '.roadmap', '001')
  const out = new Map<string, string>()
  if (!existsSync(sessionsDir)) {
    return out
  }
  for (const sessionId of readdirSync(sessionsDir)) {
    const sessionDir = join(sessionsDir, sessionId)
    if (!existsSync(sessionDir)) {
      continue
    }
    let minIndex = Infinity
    let firstTime = ''
    let title = sessionId
    for (const name of readdirSync(sessionDir).sort()) {
      if (!isChapterCardFile(name)) {
        continue
      }
      try {
        const card = parseCard(readFileSync(join(sessionDir, name), 'utf8'))
        const idx = card.frontmatter.chapter?.index ?? 0
        if (idx < minIndex) {
          minIndex = idx
          firstTime = card.frontmatter.time?.firstTime ?? ''
        }
        title = card.frontmatter.title
      } catch {
        /* skip */
      }
    }
    if (minIndex !== Infinity) {
      out.set(sessionId, firstTime)
    }
    void title
  }
  return out
}

function sourceLink(r: PitRow): string {
  return `[Ch.${r.chapter}](../001/${r.session}/${String(r.chapter).padStart(3, '0')}-${r.slug}.md) seq ${r.seq ?? '?'}`
}

function buildDetails(rows: PitRow[], firstTimes: Map<string, string>): string | null {
  if (rows.length === 0) {
    return null
  }
  const bySession = new Map<string, PitRow[]>()
  for (const r of rows) {
    bySession.set(r.session, [...(bySession.get(r.session) ?? []), r])
  }
  const sections = [...bySession.entries()]
    .sort(([sa], [sb]) => {
      const ta = firstTimes.get(sa) ?? ''
      const tb = firstTimes.get(sb) ?? ''
      if (ta !== tb) {
        return ta < tb ? -1 : 1
      }
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
    .map(([sessionId, rs]) => {
      // rows keep collection order (card filename asc, then in-card order)
      const table = [
        `## ${sessionId}`,
        '',
        '| 坑 | 症状 → 解法 | 溯源 | 验证 |',
        '|---|---|---|---|',
        ...rs.map(
          (r) =>
            `| <!-- ${r.pitId} --> ${escapeCell(canonicalKeywords(r.keywords) || r.text.slice(0, 12), DETAILS_CELL_MAX)} | ${escapeCell(
              r.symptom && r.fix ? `${r.symptom} → ${r.fix}` : r.text,
              DETAILS_CELL_MAX
            )} | ${escapeCell(sourceLink(r), 300)} | ${r.verified ? '✓' : '未验'} |`
        )
      ].join('\n')
      return table
    })
  return `# 坑详情层（派生文件，由 .roadmap/001 各卡结构化坑全量重建；按 pit-id 或关键词检索，命中行即取，勿整读）\n\n${sections.join('\n\n')}\n`
}

type MergedPit = {
  pitId: string
  k: number
  lastTime: string
  unionKeywords: string[][]
  symptomSource: string | undefined
  symptomFallback: string
}

function mergeForIndex(rows: PitRow[]): MergedPit[] {
  const byId = new Map<string, PitRow[]>()
  for (const r of rows) {
    byId.set(r.pitId, [...(byId.get(r.pitId) ?? []), r])
  }
  const merged: MergedPit[] = []
  for (const [pitId, rs] of byId) {
    const sessions = new Set(rs.map((r) => r.session))
    // latest occurrence: cardLastTime max; tie by (session dirname, card file,
    // in-card occurrence order) lexicographic — the LAST one wins (spec rule 3)
    let latestIdx = 0
    for (let i = 1; i < rs.length; i++) {
      const r = rs[i]!
      const cur = rs[latestIdx]!
      if (r.cardLastTime > cur.cardLastTime) {
        latestIdx = i
      } else if (r.cardLastTime === cur.cardLastTime) {
        const rk = `${r.session}\u0000${r.cardFile}\u0000${String(i)}`
        const ck = `${cur.session}\u0000${cur.cardFile}\u0000${String(latestIdx)}`
        if (rk > ck) {
          latestIdx = i
        }
      }
    }
    const latest = rs[latestIdx]!
    merged.push({
      pitId,
      k: sessions.size,
      lastTime: latest.cardLastTime,
      unionKeywords: rs.map((r) => r.keywords),
      symptomSource: latest.symptom,
      symptomFallback: latest.text
    })
  }
  // K desc -> lastTime desc -> pit-id lexicographic asc (final total order)
  return merged.sort((a, b) => {
    if (a.k !== b.k) {
      return b.k - a.k
    }
    if (a.lastTime !== b.lastTime) {
      return a.lastTime < b.lastTime ? 1 : -1
    }
    return a.pitId < b.pitId ? -1 : a.pitId > b.pitId ? 1 : 0
  })
}

function buildKeywordIndex(rows: PitRow[]): string | null {
  if (rows.length === 0) {
    return null
  }
  const header = [
    '# 坑索引（派生文件，由卡重建；开工扫描此表命中关键词，命中后按 pit-id 到 DETAILS.md 取行；窗口外老坑直接在 DETAILS 检索）',
    '',
    '| pit-id | 关键词 | 症状 | 复现 |',
    '|---|---|---|---|'
  ]
  const lines: string[] = []
  let used = 0
  for (const m of mergeForIndex(rows)) {
    const line = `| ${m.pitId} | ${escapeCell(unionCell(m.unionKeywords), 200)} | ${escapeCell(symptomOneLiner(m.symptomSource, m.symptomFallback), 120)} | ×${m.k} |`
    const cost = countCodePoints(line)
    if (lines.length >= INDEX_MAX_ROWS || used + cost > INDEX_MAX_CODE_POINTS) {
      break // whole-row boundary: this row and everything after leaves the window
    }
    lines.push(line)
    used += cost
  }
  if (lines.length === 0) {
    return null
  }
  return `${header.concat(lines).join('\n')}\n`
}

function writeIfChanged(path: string, next: string): 'written' | 'unchanged' {
  if (existsSync(path) && readFileSync(path, 'utf8') === next) {
    return 'unchanged'
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, path)
  return 'written'
}

/** Rename a legacy single-file KEYWORDS.md aside (numeric suffix, never overwrite). */
function migrateLegacy(pitsDir: string): string | null {
  const path = join(pitsDir, 'KEYWORDS.md')
  if (!existsSync(path)) {
    return null
  }
  const current = readFileSync(path, 'utf8')
  // trigger: the legacy header row
  if (!current.includes('| 关键词 | 症状 → 解法 |')) {
    return null
  }
  let target = join(pitsDir, 'KEYWORDS.legacy.bak.md')
  let n = 1
  while (existsSync(target)) {
    target = join(pitsDir, `KEYWORDS.legacy.bak.${n}.md`)
    n++
  }
  renameSync(path, target)
  return target
}

export type RebuildResult = {
  keywords: string | null
  details: string | null
  legacyRenamed: string | null
}

/**
 * Rebuild the two pit files from all chapter cards. Write order:
 * DETAILS first, KEYWORDS second (the pointer side commits last; a crash
 * window leaves the index at most one version behind, the DETAILS grep
 * channel intact, and the next rebuild converges).
 */
export function rebuildPitsIndex(root: string): RebuildResult | null {
  const rows = collectRows(root)
  const firstTimes = sessionFirstTimes(root)
  const details = buildDetails(rows, firstTimes)
  const index = buildKeywordIndex(rows)
  if (!details && !index) {
    return null
  }
  const pitsDir = join(root, '.roadmap', 'pits')
  mkdirSync(pitsDir, { recursive: true })
  const legacyRenamed = migrateLegacy(pitsDir)
  let detailsPath: string | null = null
  let keywordsPath: string | null = null
  if (details) {
    detailsPath =
      writeIfChanged(join(pitsDir, 'DETAILS.md'), details) === 'written'
        ? join(pitsDir, 'DETAILS.md')
        : null
  }
  if (index) {
    keywordsPath =
      writeIfChanged(join(pitsDir, 'KEYWORDS.md'), index) === 'written'
        ? join(pitsDir, 'KEYWORDS.md')
        : null
  }
  return { keywords: keywordsPath, details: detailsPath, legacyRenamed }
}
