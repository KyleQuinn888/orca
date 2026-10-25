// Terminology consistency: B) rolling injection — feed the next chapter the
// term pairs already established in EARLIER chapter cards so renderings stay
// stable; C) post-hoc lint — same jargon mapped to different standard terms
// across cards, reported non-blocking. Zero maintenance: the cards ARE the
// glossary. Review-driven hardening: pairs come only from chapters STRICTLY
// BEFORE the one being generated (regenerating ch5 must not treat stale
// ch5/ch10 as canon), cross-chapter dedupe, an injection cap, and the prose
// fallback trusts ONLY the injection-header line format (a free-prose regex
// proved to absorb junk prefixes like "我们最终采用了冻结参数集" and then
// get canonized by the reuse rule — a garbage-feedback loop).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isChapterCardFile } from './chapter-files'
import { parseCard } from './card'

export type TermPair = { standard: string; jargon: string; chapter: number }

/** Trusted fallback: only pairs formatted exactly like the injection header. */
const HEADER_LINE = /^- ([^\s「」（）()，。；：、"'/]{2,16})（会话内称「([^」]{1,16})」）$/gm

export function extractTermPairs(text: string): { standard: string; jargon: string }[] {
  const pairs: { standard: string; jargon: string }[] = []
  for (const match of text.matchAll(HEADER_LINE)) {
    pairs.push({ standard: match[1]!, jargon: match[2]! })
  }
  return pairs
}

/** Pairs established in chapter cards with index < currentChapter. */
export function establishedTerms(sessionDir: string, currentChapter: number): TermPair[] {
  const byPair = new Map<string, TermPair>()
  if (!existsSync(sessionDir)) {
    return []
  }
  for (const name of readdirSync(sessionDir).sort()) {
    if (!isChapterCardFile(name)) {
      continue
    }
    const chapter = Number(/^(\d+)-/.exec(name)?.[1] ?? '0')
    if (chapter >= currentChapter) {
      continue
    }
    const text = readFileSync(join(sessionDir, name), 'utf8')
    // Structured `terms:` block is the primary source (model-declared);
    // header-format lines remain the fallback for cards without the block.
    let declared: { standard: string; jargon: string }[] | null = null
    try {
      const card = parseCard(text)
      declared = card.terms && card.terms.length > 0 ? card.terms : null
    } catch {
      declared = null
    }
    for (const pair of declared ?? extractTermPairs(text)) {
      const key = `${pair.standard}=${pair.jargon}`
      if (!byPair.has(key)) {
        byPair.set(key, { ...pair, chapter })
      }
    }
  }
  return [...byPair.values()]
}

const INJECTION_CAP = 60

/** Rolling-injection header for the next chapter's digest. */
export function termInjectionHeader(pairs: TermPair[]): string {
  if (pairs.length === 0) {
    return ''
  }
  const lines = ['已确立标准术语（前章定稿，沿用同一写法，禁止改用近义表述）：']
  for (const pair of pairs.slice(0, INJECTION_CAP)) {
    lines.push(`- ${pair.standard}（会话内称「${pair.jargon}」）`)
  }
  if (pairs.length > INJECTION_CAP) {
    lines.push(
      `（另有 ${pairs.length - INJECTION_CAP} 对早期低频术语未列出，如遇未见过的会话黑话按术语规范自行括注）`
    )
  }
  return `${lines.join('\n')}\n\n`
}

export type TermConflict = { jargon: string; renderings: string[]; chapters: number[] }

/** Post-hoc lint: same jargon rendered differently across chapters. */
export function lintTerms(sessionDir: string): TermConflict[] {
  const byJargon = new Map<string, Map<string, number[]>>()
  for (const pair of establishedTerms(sessionDir, Number.MAX_SAFE_INTEGER)) {
    if (!byJargon.has(pair.jargon)) {
      byJargon.set(pair.jargon, new Map())
    }
    const renderings = byJargon.get(pair.jargon)!
    if (!renderings.has(pair.standard)) {
      renderings.set(pair.standard, [])
    }
    renderings.get(pair.standard)!.push(pair.chapter)
  }
  const conflicts: TermConflict[] = []
  for (const [jargon, renderings] of byJargon) {
    if (renderings.size > 1) {
      conflicts.push({
        jargon,
        renderings: [...renderings.keys()],
        chapters: [...new Set([...renderings.values()].flat())].sort((a, b) => a - b)
      })
    }
  }
  return conflicts
}
