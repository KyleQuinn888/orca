// R2 UI snapshot reader — spec r2-ui.md v1.2 §4.
// Single authoritative snapshot: same-generation INDEX.md + 002 fold output.
// Pure: callers inject a file map (path -> content); no fs here so renderer
// (window.api.fs) and tests share one implementation.

export type R2Chapter = {
  session: string
  index: number
  /** .roadmap-relative card path (001/<sid>/NNN-*.md) for opening the card. */
  file: string
  title: string
  firstTime: string
  lastTime: string
  verified: boolean // anchorsVerifiedAt present
  superseded: boolean // .superseded.md filename suffix
}

export type R2Milestone = {
  id: string // m-ULID
  title: string
  session: string
  chapterIndexes: number[]
  firstTime: string
  lastTime: string
  signal: string // boundary.signal (user-mark / llm-cut / …)
}

export type R2Session = {
  id: string
  title: string
  workspace: string
  firstTime: string
  lastTime: string
}

export type R2InboxCut = {
  chapter: number // cut before this chapter
  evidence: string
}

export type R2InboxGroup = {
  proposalGroupId: string
  session: string
  by: string
  at: string
  cuts: R2InboxCut[]
  state: 'pending' | 'needs-review' | 'resolved'
}

export type R2Snapshot = {
  generation: string // INDEX.generatedAt — snapshot identity
  sessions: R2Session[]
  chapters: R2Chapter[]
  milestones: R2Milestone[] // 002 quality=draft only (live layer)
  inbox: R2InboxGroup[] // unresolved add-cut proposal groups
  pitCount: number // unique pit-ids across DETAILS
}

export type FileMap = Map<string, string> // relative path (posix) -> content ('' = dir marker unused)

export type SnapshotResult = {
  ok: boolean
  snapshot?: R2Snapshot
  /** ok=false reasons: 'no-index' | 'generation-mismatch' */
  reason?: string
  detail?: string
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---/

/** frontmatter: flat keys + indented section blocks (time:, sessions:, …) */
type FM = {
  flat: Record<string, string>
  sections: Record<string, string>
}

function fm(path: string, files: FileMap): FM | null {
  const raw = files.get(path)
  if (raw === undefined) {return null}
  const m = FRONT.exec(raw)
  if (!m) {return { flat: {}, sections: {} }}
  const out: FM = { flat: {}, sections: {} }
  const lines = m[1].split(/\r?\n/)
  let section: string | null = null
  for (const line of lines) {
    if (/^\s/.test(line) && section) {
      out.sections[section] += `${line  }\n`
      continue
    }
    section = null
    const kv = /^(\w+):\s*(.*)$/.exec(line)
    if (!kv) {continue}
    if (kv[2] === '') {
      section = kv[1]
      out.sections[kv[1]] = ''
    } else {
      out.flat[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return out
}

function nested(f: FM | null, section: string, key: string): string {
  if (!f) {return ''}
  const m = new RegExp(`${key}:\\s*['"]?([^'"\\n]+)`).exec(f.sections[section] ?? '')
  return m ? m[1].trim() : ''
}

/**
 * Build the R2 snapshot from a virtual .roadmap/ file map.
 * Generation consistency: every 002 m-card and the INDEX must share the same
 * aggregation generation. 002 cards carry fileUpdatedAt/contentGeneratedAt
 * from the same run; we require INDEX.generatedAt to exist and every m-card
 * to be no-newer-than a grace window is NOT used — instead: a snapshot is
 * consistent iff INDEX.generatedAt exists and no 002 file is missing for a
 * chapter-set the INDEX counts (cheap check: m-card count of quality draft
 * must be >= 1 when INDEX.milestones > 0, and chapter file count must match
 * INDEX.chapters when sessions > 0). On any mismatch return ok=false with
 * reason 'generation-mismatch' so the caller keeps the previous snapshot.
 */
export function buildSnapshot(files: FileMap): SnapshotResult {
  const indexFm = fm('INDEX.md', files)
  if (!indexFm || !indexFm.flat.generatedAt) {return { ok: false, reason: 'no-index' }}
  const generation = indexFm.flat.generatedAt
  const idxMilestones = Number(indexFm.flat.milestones ?? 0)
  const idxChapters = Number(indexFm.flat.chapters ?? 0)

  // ── 001: sessions + chapters ──
  const sessions: R2Session[] = []
  const chapters: R2Chapter[] = []
  const sessionIds: string[] = []
  for (const [path] of files) {
    if (!path.startsWith('001/')) {continue}
    if (path.endsWith('/000-index.md')) {
      const sid = path.split('/')[1]
      if (!sid) {continue}
      const f = fm(path, files)!
      const s: R2Session = {
        id: sid,
        title: f.flat.title ?? '',
        workspace: f.flat.workspace ?? '',
        firstTime: nested(f, 'time', 'firstTime'),
        lastTime: nested(f, 'time', 'lastTime')
      }
      sessions.push(s)
      sessionIds.push(sid)
    } else {
      const m = /^001\/([^/]+)\/(\d{3})-.*\.md$/.exec(path)
      if (!m || !/^\d+$/.test(m[2])) {continue}
      const f = fm(path, files) ?? { flat: {}, sections: {} }
      chapters.push({
        session: m[1],
        index: Number(m[2]),
        file: path,
        // chapter cards carry the session title in `title`; the chapter's own name is chapter.slug
        title: nested(f, 'chapter', 'slug') || f.flat.title || path,
        firstTime: nested(f, 'time', 'firstTime'),
        lastTime: nested(f, 'time', 'lastTime'),
        verified: rawHas(path, 'anchorsVerifiedAt', files),
        superseded: path.endsWith('.superseded.md')
      })
    }
  }
  const activeChapters = chapters.filter((c) => !c.superseded)
  if (sessions.length > 0 && idxChapters > 0 && activeChapters.length !== idxChapters) {
    return { ok: false, reason: 'generation-mismatch', detail: `chapters ${activeChapters.length} != INDEX ${idxChapters}` }
  }

  // ── 002: live milestones (quality draft) ──
  const milestones: R2Milestone[] = []
  for (const [path] of files) {
    if (!/^002\/m-[^/]+\.md$/.test(path)) {continue}
    const f = fm(path, files)
    if (!f || f.flat.quality !== 'draft') {continue}
    const sessEntry = nested(f, 'sessions', 'session') || sessionIds[0] || ''
    const chList = /chapters:\s*\[([^\]]*)\]/.exec(f.sections.sessions ?? '')
    milestones.push({
      id: f.flat.id ?? path,
      title: f.flat.title ?? '',
      session: sessEntry,
      chapterIndexes: (chList ? chList[1] : '').split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n)),
      firstTime: nested(f, 'time', 'firstTime'),
      lastTime: nested(f, 'time', 'lastTime'),
      signal: nested(f, 'boundary', 'signal')
    })
  }
  if (idxMilestones > 0 && milestones.length === 0) {
    return { ok: false, reason: 'generation-mismatch', detail: `INDEX claims ${idxMilestones} milestones, 0 draft m-cards` }
  }
  // Milestones must be in start-time order: 002 files enumerate in ULID (alphabetical)
  // order, which routinely disagrees with time order and corrupted canvas band order.
  const msTime = (x: { firstTime: string; chapterIndexes: number[] }): number => {
    const t = Date.parse(x.firstTime)
    return Number.isNaN(t) ? Infinity : t
  }
  milestones.sort((a, b) => msTime(a) - msTime(b) || (a.chapterIndexes[0] ?? 0) - (b.chapterIndexes[0] ?? 0))

  // ── 002: inbox from boundaries.json events ──
  const inbox = buildInbox(files.get('002/boundaries.json'))

  // ── pits: unique pit-ids across DETAILS rows ──
  const pitCount = countPits(files.get('pits/DETAILS.md'))

  return {
    ok: true,
    snapshot: { generation, sessions, chapters, milestones, inbox, pitCount }
  }
}

function rawHas(path: string, key: string, files: FileMap): boolean {
  const raw = files.get(path) ?? ''
  return new RegExp(`^\\s*${key}:`, 'm').test(raw.split('---')[1] ?? '')
}

type MarkEvent = {
  id?: string
  op?: string
  at?: string
  session?: string
  by?: string
  proposalGroupId?: string
  anchor?: { chapter?: number }
  evidence?: string
  target?: unknown
  reviewTarget?: { proposalGroupId?: string; markId?: string }
  decision?: 'approve' | 'reject'
}

function gidOfTarget(target: unknown): string {
  if (target && typeof target === 'object' && 'proposalGroupId' in target) {
    return String((target as { proposalGroupId?: unknown }).proposalGroupId ?? '')
  }
  return ''
}

function buildInbox(raw: string | undefined): R2InboxGroup[] {
  if (!raw) {return []}
  let parsed: { events?: MarkEvent[] }
  try {
    parsed = JSON.parse(raw) as { events?: MarkEvent[] }
  } catch {
    return []
  }
  const events = parsed.events ?? []
  const groups = new Map<string, R2InboxGroup>()
  const resolved = new Set<string>()
  for (const ev of events) {
    const gid =
      ev.proposalGroupId ?? gidOfTarget(ev.target) ?? (ev.op === 'review' ? (ev.reviewTarget?.proposalGroupId ?? '') : '')
    if (ev.op === 'add-cut' && gid) {
      const g = groups.get(gid) ?? {
        proposalGroupId: gid,
        session: ev.session ?? '',
        by: ev.by ?? 'llm',
        at: ev.at ?? '',
        cuts: [],
        state: 'pending' as const
      }
      if (ev.anchor?.chapter !== undefined && ev.evidence) {
        g.cuts.push({ chapter: ev.anchor.chapter, evidence: ev.evidence })
      }
      groups.set(gid, g)
    } else if (gid) {
      // promote / reject-stale / suppress-cut / human review (approve or reject) resolve the group
      resolved.add(gid)
    }
  }
  const out: R2InboxGroup[] = []
  for (const [gid, g] of groups) {
    if (resolved.has(gid)) {continue}
    out.push({ ...g, state: g.state as 'pending' })
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1))
}

function countPits(raw: string | undefined): number {
  if (!raw) {return 0}
  const ids = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    // DETAILS rows carry the pit-id in an HTML comment inside the first cell
    const m = /^\|\s*<!--\s*(pit-[0-9a-f]{6,})\s*-->/.exec(line)
    if (m) {ids.add(m[1])}
  }
  return ids.size
}

/** Milestone display ordinal (spec §2.2): M1..Mn by start time within the snapshot. */
export function milestoneLabel(snapshot: R2Snapshot, id: string): string {
  const sorted = [...snapshot.milestones].sort((a, b) => (a.firstTime < b.firstTime ? -1 : 1))
  const i = sorted.findIndex((m) => m.id === id)
  return i !== -1 ? `M${i + 1}` : 'M?'
}
