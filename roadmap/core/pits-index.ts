// Project-level pit keyword layer (.roadmap/pits/KEYWORDS.md): the agent-facing
// progressive-disclosure surface (vision feature 3.5). Fully DERIVED: rebuilt
// by scanning every session's chapter cards on disk (structured pits are
// persisted in the cards themselves), so partial rebuilds cannot lose rows
// and repeated runs are idempotent by construction. Keywords carry BOTH
// standard terminology and session jargon so an agent grepping either hits.

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
import { parseCard } from './card'

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
}

/**
 * Rebuild the whole KEYWORDS.md from all chapter cards under
 * root/.roadmap/001 (each session directory). The verifiedBySeq set carries
 * keys `${sessionId}:${seq}` — a bare seq would let one session's verified
 * row vouch for another session's colliding seq (cross-session fake ✓).
 * When the set is OMITTED every row reports unverified (fail-closed).
 */
export function rebuildPitsIndex(root: string, verifiedBySeq?: Set<string>): string | null {
  const sessionsDir = join(root, '.roadmap', '001')
  if (!existsSync(sessionsDir)) {
    return null
  }
  const sections: string[] = []
  for (const sessionId of readdirSync(sessionsDir).sort()) {
    const sessionDir = join(sessionsDir, sessionId)
    if (!existsSync(sessionDir)) {
      continue
    }
    const rows: PitRow[] = []
    let sessionTitle = sessionId
    for (const name of readdirSync(sessionDir).sort()) {
      if (!isChapterCardFile(name)) {
        continue
      }
      try {
        const card = parseCard(readFileSync(join(sessionDir, name), 'utf8'))
        sessionTitle = card.frontmatter.title
        const chapter = card.frontmatter.chapter?.index ?? 0
        const slug = card.frontmatter.chapter?.slug ?? ''
        for (const pit of card.pits) {
          rows.push({
            session: sessionId,
            chapter,
            slug,
            seq: pit.seq,
            keywords: pit.keywords,
            symptom: pit.symptom,
            fix: pit.fix,
            text: pit.text,
            verified:
              pit.seq !== undefined &&
              verifiedBySeq !== undefined &&
              verifiedBySeq.has(`${sessionId}:${pit.seq}`)
          })
        }
      } catch {
        console.warn(`[roadmap] rebuildPitsIndex skipping unparseable card: ${sessionId}/${name}`)
      }
    }
    if (rows.length > 0) {
      const table = [
        `## ${sessionId} ${sessionTitle}`,
        '',
        '| 关键词 | 症状 → 解法 | 溯源 | 验证 |',
        '|---|---|---|---|',
        ...rows.map(
          (r) =>
            `| ${escapeCell(r.keywords.join('、')) || escapeCell(r.text.slice(0, 12))} | ${escapeCell(
              r.symptom && r.fix ? `${r.symptom} → ${r.fix}` : r.text
            )} | ${escapeCell(
              `[Ch.${r.chapter}](../001/${r.session}/${String(r.chapter).padStart(3, '0')}-${r.slug}.md) seq ${r.seq ?? '?'}`,
              300
            )} | ${r.verified ? '✓' : '未验'} |`
        )
      ].join('\n')
      sections.push(table)
    }
  }
  if (sections.length === 0) {
    return null
  }
  const pitsDir = join(root, '.roadmap', 'pits')
  mkdirSync(pitsDir, { recursive: true })
  const path = join(pitsDir, 'KEYWORDS.md')
  const body = [
    '# 坑关键词层（派生文件，由 .roadmap/001 各卡结构化坑全量重建；agent 开工前先扫本表命中关键词）',
    ...sections
  ].join('\n\n')
  const next = `${body}\n`
  const tmp = `${path}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, path)
  return path
}
