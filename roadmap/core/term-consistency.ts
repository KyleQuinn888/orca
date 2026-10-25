// Terminology consistency: B) rolling injection — extract term pairs already
// established in earlier chapter cards (标准词（会话内称「黑话」） pattern) and
// feed them to the next chapter so renderings stay stable; C) post-hoc lint —
// detect the same jargon mapping to different standard terms across cards and
// report (non-blocking). Zero maintenance by design: the cards ARE the
// glossary.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type TermPair = { standard: string; jargon: string; chapter: number }

const PAIR_PATTERN = /([^\s「」（）()，。；：、"'\\/]{2,16})（会话内称「([^」]{1,16})」）/g

export function extractTermPairs(text: string): { standard: string; jargon: string }[] {
  const pairs: { standard: string; jargon: string }[] = []
  for (const match of text.matchAll(PAIR_PATTERN)) {
    pairs.push({ standard: match[1]!, jargon: match[2]! })
  }
  return dedupe(pairs)
}

function dedupe(
  pairs: { standard: string; jargon: string }[]
): { standard: string; jargon: string }[] {
  const seen = new Set<string>()
  return pairs.filter((p) => {
    const key = `${p.standard}=${p.jargon}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/** Pairs established in already-written chapter cards (index < current). */
export function establishedTerms(sessionDir: string): TermPair[] {
  const pairs: TermPair[] = []
  if (!existsSync(sessionDir)) {
    return pairs
  }
  for (const name of readdirSync(sessionDir).sort()) {
    if (
      !/^\d+-.*\.md$/.test(name) ||
      name.includes('index') ||
      name.endsWith('.superseded.md') ||
      name.endsWith('.new.md')
    ) {
      continue
    }
    const chapter = Number(/^(\d+)-/.exec(name)?.[1] ?? '0')
    const text = readFileSync(join(sessionDir, name), 'utf8')
    for (const pair of extractTermPairs(text)) {
      pairs.push({ ...pair, chapter })
    }
  }
  return pairs
}

/** Rolling-injection header for the next chapter's digest. */
export function termInjectionHeader(pairs: TermPair[]): string {
  if (pairs.length === 0) {
    return ''
  }
  const lines = ['已确立标准术语（前章定稿，沿用同一写法，禁止改用近义表述）：']
  for (const pair of pairs) {
    lines.push(`- ${pair.standard}（会话内称「${pair.jargon}」）`)
  }
  return `${lines.join('\n')}\n\n`
}

export type TermConflict = { jargon: string; renderings: string[]; chapters: number[] }

/** Post-hoc lint: same jargon rendered differently across chapters. */
export function lintTerms(sessionDir: string): TermConflict[] {
  const byJargon = new Map<string, Map<string, number[]>>()
  for (const pair of establishedTerms(sessionDir)) {
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
