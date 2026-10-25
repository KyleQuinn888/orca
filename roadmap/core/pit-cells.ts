// Pit cell pure helpers — spec agent-retrieval v1.4 §6
// Code-point ordering, keyword-set identity, capped display cells.

import { createHash } from 'node:crypto'

/** Compare strings by Unicode code points (spec ordering basis). */
export function cmpCodePoints(a: string, b: string): number {
  const ai = Array.from(a)
  const bi = Array.from(b)
  const n = Math.min(ai.length, bi.length)
  for (let i = 0; i < n; i++) {
    const d = ai[i]!.codePointAt(0)! - bi[i]!.codePointAt(0)!
    if (d !== 0) {
      return d
    }
  }
  return ai.length - bi.length
}

/** Canonical keyword string: deduped, code-point sorted, 、-joined. */
export function canonicalKeywords(keywords: string[]): string {
  return [...new Set(keywords)].sort(cmpCodePoints).join('、')
}

/** pit-id: identity = the keyword set itself (session/seq excluded by design). */
export function pitIdOf(keywords: string[]): string {
  const kw = canonicalKeywords(keywords)
  return `pit-${createHash('sha256').update(kw, 'utf8').digest('hex').slice(0, 6)}`
}

/** Collapse whitespace, cap at 25 code points, append … when truncated. */
export function symptomOneLiner(source: string | undefined, fallback: string): string {
  const raw = (source && source.trim()) || fallback
  const collapsed = raw.replace(/[\s]+/g, ' ')
  const cps = Array.from(collapsed)
  if (cps.length <= 25) {
    return cps.join('')
  }
  return `${cps.slice(0, 25).join('')}…`
}

/** Union cell: deduped, code-point sorted, capped at 79 code points + … (=80). */
export function unionCell(keywordSets: string[][]): string {
  const all = [...new Set(keywordSets.flat())].sort(cmpCodePoints)
  const cps = Array.from(all.join('、'))
  if (cps.length <= 79) {
    return cps.join('')
  }
  return `${cps.slice(0, 79).join('')}…`
}

export function countCodePoints(s: string): number {
  return Array.from(s).length
}
