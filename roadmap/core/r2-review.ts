// Review consequence preview — spec r2-ui.md v1.2 §1.1: approve confirm shows
// the current vs resulting milestone grouping. Pure derivation from snapshot.

import type { R2InboxGroup, R2Snapshot } from './r2-snapshot'

export type GroupingRow = {
  /** milestone id when the row is an existing milestone; '' for a would-be new segment */
  mid: string
  label: string
  chapterFrom: number
  chapterTo: number
  /** true when this row only exists after the cuts are approved */
  isNew: boolean
  /** existing rows this row fully or partially replaces */
  replaces: string[]
}

export type Consequence = {
  session: string
  /** current grouping (active chapters covered by milestones, in order) */
  before: GroupingRow[]
  /** grouping after applying the group's cuts */
  after: GroupingRow[]
}

function labelFor(sorted: { id: string }[], id: string): string {
  const i = sorted.findIndex((m) => m.id === id)
  return i >= 0 ? `M${i + 1}` : 'M?'
}

/**
 * Derive the before/after grouping a reviewer compares. Cuts split the session's
 * chapter axis: every cut chapter starts a new segment (existing milestone titles
 * carry over to the segment that keeps their first chapter; splits produce
 * untitled new rows labeled M+).
 */
export function consequenceOf(snap: R2Snapshot, group: R2InboxGroup): Consequence {
  const msSorted = [...snap.milestones].sort((a, b) => (a.firstTime < b.firstTime ? -1 : 1))
  const byLabel = (id: string): string => labelFor(msSorted, id)

  const chapters = snap.chapters
    .filter((c) => c.session === group.session && !c.superseded)
    .map((c) => c.index)
    .sort((a, b) => a - b)
  const owner = new Map<number, string>()
  for (const m of snap.milestones) {
    for (const n of m.chapterIndexes) {
      if (chapters.includes(n)) {
        owner.set(n, m.id)
      }
    }
  }

  const cutChapters = group.cuts.map((c) => c.chapter).sort((a, b) => a - b)
  const segments: Array<{ from: number; to: number }> = []
  let start = chapters[0] ?? 0
  for (const cut of cutChapters) {
    if (cut > start && cut <= (chapters.at(-1) ?? 0)) {
      segments.push({ from: start, to: cut - 1 })
      start = cut
    }
  }
  if (chapters.length) {
    segments.push({ from: start, to: chapters.at(-1)! })
  }

  const before: GroupingRow[] = []
  const seen = new Set<string>()
  for (const ch of chapters) {
    const mid = owner.get(ch) ?? ''
    if (mid && !seen.has(mid)) {
      seen.add(mid)
      const rows = snap.milestones.find((m) => m.id === mid)!
      before.push({
        mid,
        label: byLabel(mid),
        chapterFrom: rows.chapterIndexes.filter((n) => chapters.includes(n))[0] ?? ch,
        chapterTo: rows.chapterIndexes.filter((n) => chapters.includes(n)).at(-1) ?? ch,
        isNew: false,
        replaces: []
      })
    }
  }

  // after: for each segment, if it begins exactly where an existing milestone
  // begins (and covers its head), that milestone keeps its title; otherwise new.
  const after: GroupingRow[] = []
  let newCount = 0
  for (const seg of segments) {
    const headMid = owner.get(seg.from) ?? ''
    const headM = snap.milestones.find((m) => m.id === headMid)
    const startsAtHead = headM != null && (headM.chapterIndexes.filter((n) => chapters.includes(n))[0] ?? -1) === seg.from
    const replaced = [...new Set(chapters.slice(seg.from - (chapters[0] ?? 1), seg.to - (chapters[0] ?? 1) + 1).map((n) => owner.get(n) ?? '').filter(Boolean))]
    if (startsAtHead) {
      after.push({ mid: headMid, label: byLabel(headMid), chapterFrom: seg.from, chapterTo: seg.to, isNew: false, replaces: [] })
    } else {
      newCount += 1
      after.push({ mid: '', label: `新分段 ${newCount}`, chapterFrom: seg.from, chapterTo: seg.to, isNew: true, replaces: replaced })
    }
  }
  // relabel after-rows with positional M# so the preview reads like the canvas
  after.forEach((row, i) => {
    if (!row.isNew) {
      row.label = `M${i + 1}`
    }
  })

  return { session: group.session, before, after }
}
