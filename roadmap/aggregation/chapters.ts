// Chapter loading + signal positioning — spec layer-002-003 v7.3
// Live chapter set, per-chapter version identity, chapterSetHash v2,
// journal-signal types and their boundary-position mapping.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from './marks-store'

export type Chapter = {
  file: string
  index: number
  heading: string
  slug: string
  firstMsgSeq: number
  lastMsgSeq: number
  firstTime: string
  lastTime: string
  versionHash: string // sha256 of card file content, first 8 hex
  points: string[]
  decisions: string[]
}

export function loadChapters(sessionDir: string): Chapter[] {
  const files = readdirSync(sessionDir)
    .filter(
      (n) =>
        /^\d+-.*\.md$/.test(n) &&
        !n.endsWith('.superseded.md') &&
        !n.endsWith('.new.md') &&
        !n.includes('index')
    )
    .sort()
  return files.map((name) => {
    const text = readFileSync(join(sessionDir, name), 'utf8')
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
    const num = (re: RegExp): number => Number(re.exec(fm)?.[1] ?? 0)
    return {
      file: name,
      index: Number(/^(\d+)-/.exec(name)?.[1] ?? 0),
      heading: /^# (.+)$/m.exec(text)?.[1]?.replace(/^Ch\.\d+\s*/, '') ?? name,
      slug: name.replace(/^\d+-/, '').replace(/\.md$/, ''),
      firstMsgSeq: num(/firstMsgSeq: (\d+)/),
      lastMsgSeq: num(/lastMsgSeq: (\d+)/),
      firstTime: /firstTime: '(.+?)'/.exec(fm)?.[1] ?? '',
      lastTime: /lastTime: '(.+?)'/.exec(fm)?.[1] ?? '',
      versionHash: sha256Hex(text).slice(0, 8),
      points:
        text
          .match(/## 要点\n([\s\S]*?)(?=\n## )/)?.[1]
          ?.split('\n')
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2, 120))
          .slice(0, 3) ?? [],
      decisions:
        text
          .match(/## 关键决策\n([\s\S]*?)(?=\n## )/)?.[1]
          ?.split('\n')
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2, 100))
          .slice(0, 2) ?? []
    }
  })
}

/** chapterSetHash v2: per-chapter version identity covers 001 content swaps at stable indices. */
export function chapterSetHash(chapters: Chapter[]): string {
  const parts = chapters
    .map((c) => `${c.index}:${c.versionHash}`)
    .sort((a, b) => {
      const [ai] = a.split(':')
      const [bi] = b.split(':')
      return Number(ai) - Number(bi)
    })
  return sha256Hex(parts.join(',')).slice(0, 8)
}

// ─── Signals (journal-derived; TUI source has none) ──────────────────────

export type SignalType = 'user-mark' | 'goal-set' | 'orca-stop' | 'time-gap'

export type Signal = { signalType: SignalType; seq: number }

export const SIGNAL_TIER: Record<SignalType, number> = {
  'user-mark': 2,
  'goal-set': 3,
  'orca-stop': 4,
  'time-gap': 5
}

/** Boundary position = the chapter index the boundary sits BEFORE (the chapter containing the signal seq). */
export function positionOfSeq(seq: number, chapters: Chapter[]): number | null {
  const sorted = [...chapters].sort((a, b) => a.index - b.index)
  for (const c of sorted) {
    if (seq <= c.lastMsgSeq) {
      return c.index
    }
  }
  return null // beyond the last chapter: no boundary
}
