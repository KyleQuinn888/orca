// Post-backfill aggregation: after chapters are written, auto-group them into
// milestones, write 002 m-cards, update INDEX.md. Called by the pipeline after
// all cuts are processed. The grouping is heuristic (batch of ~4); LLM proposal
// refinement can replace it later without changing the interface.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync
} from 'node:fs'
import { join } from 'node:path'
import { ulid } from '../../../roadmap/aggregation/marks-store'
import { rebuildPitsIndex } from '../../../roadmap/core/pits-index'

const CHAPTERS_PER_MILESTONE = 4

type ChapterMeta = {
  index: number
  title: string
  firstTime: string
  lastTime: string
  file: string
}

/**
 * Read chapter cards from 001/<sid>/, group into milestones, write 002 m-cards
 * and INDEX.md. Idempotent: re-running overwrites cleanly.
 */
export function aggregateAfterBackfill(workspace: string, nativeSessionId: string): void {
  const roadmapDir = join(workspace, '.roadmap')
  const dir001 = join(roadmapDir, '001', nativeSessionId)
  const dir002 = join(roadmapDir, '002')
  if (!existsSync(dir001)) {
    return
  }

  // 1. Read all active chapter cards
  const chapters: ChapterMeta[] = []
  for (const name of readdirSync(dir001).sort()) {
    if (name.startsWith('000-') || name.endsWith('.superseded.md')) {
      continue
    }
    const m = /^(\d{3})-.*\.md$/.exec(name)
    if (!m) {
      continue
    }
    const raw = readFileSync(join(dir001, name), 'utf-8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    if (!fm) {
      continue
    }
    const getNested = (_section: string, key: string): string => {
      const sm = new RegExp(`${key}:\\s*['"]?([^'"\\n]+)`).exec(fm[1])
      return sm ? sm[1].trim() : ''
    }
    const title = getNested('chapter', 'slug') || /^title:\s*'?(.+?)'?\n/m.exec(fm[1])?.[1] || name
    chapters.push({
      index: Number(m[1]),
      title,
      firstTime: getNested('time', 'firstTime'),
      lastTime: getNested('time', 'lastTime'),
      file: name
    })
  }
  if (chapters.length === 0) {
    return
  }
  chapters.sort((a, b) => a.index - b.index)

  // 2. Supersede all previous draft m-cards for this session (idempotent re-run)
  mkdirSync(dir002, { recursive: true })
  for (const name of readdirSync(dir002)) {
    if (!/^m-[^/]+\.md$/.test(name) || name.includes('.bak')) {
      continue
    }
    const raw = readFileSync(join(dir002, name), 'utf-8')
    if (raw.includes(`session: ${nativeSessionId}`) && /^quality: draft$/m.test(raw)) {
      const next = raw.replace(/^quality: draft$/m, 'quality: superseded')
      writeFileSync(join(dir002, name), next, 'utf-8')
    }
  }

  // 3. Group chapters into milestones (batch heuristic)
  const groups: ChapterMeta[][] = []
  for (let i = 0; i < chapters.length; i += CHAPTERS_PER_MILESTONE) {
    groups.push(chapters.slice(i, i + CHAPTERS_PER_MILESTONE))
  }

  // 4. Write m-cards
  const written: { title: string; from: number; to: number }[] = []
  for (const group of groups) {
    const mid = `m-${ulid()}`
    const from = group[0]!
    const to = group.at(-1)!
    const groupTitle = from.title.slice(0, 30)
    const mcard = [
      '---',
      'v: 1',
      'kind: milestone',
      `id: ${mid}`,
      `boundaryKey: ${nativeSessionId}:auto:0`,
      `chapterSetHash: auto`,
      `title: ${groupTitle}`,
      'boundary:',
      '  signal: auto-backfill',
      `  evidence: auto-grouped (${group.length} chapters)`,
      'sessions:',
      `  - session: ${nativeSessionId}`,
      `    chapters: [${group.map((c) => c.index).join(', ')}]`,
      'time:',
      `  firstTime: '${from.firstTime}'`,
      `  lastTime: '${to.lastTime}'`,
      'quality: draft',
      'provenance: heuristic',
      '---',
      '',
      `# ${groupTitle}`,
      '',
      `Auto-grouped milestone covering Ch.${from.index}–${to.index}.`,
      ''
    ].join('\n')
    const tmp = join(dir002, `${mid}.md.tmp`)
    writeFileSync(tmp, mcard, 'utf-8')
    renameSync(tmp, join(dir002, `${mid}.md`))
    written.push({ title: groupTitle, from: from.index, to: to.index })
  }

  // 5. Rebuild workspace INDEX.md
  rebuildIndexForAll(roadmapDir)

  // 6. Rebuild pits
  try {
    rebuildPitsIndex(workspace)
  } catch {
    // pits rebuild failure doesn't block milestone display
  }

  // 7. Update session title in 000-index.md from the first chapter (the
  // runtime's getSessionTitle returns the raw session ID for zcode sessions
  // because agent_session_records is keyed by journal id, not native id)
  const idxPath = join(dir001, '000-index.md')
  if (existsSync(idxPath) && chapters.length > 0) {
    const idxRaw = readFileSync(idxPath, 'utf-8')
    const firstChapterTitle = chapters[0]!.title
    const updated = idxRaw.replace(/^title:\s*.*$/m, `title: ${firstChapterTitle.slice(0, 40)}`)
    if (updated !== idxRaw) {
      writeFileSync(idxPath, updated, 'utf-8')
    }
  }
}

function rebuildIndexForAll(roadmapDir: string): void {
  const dir001 = join(roadmapDir, '001')
  const dir002 = join(roadmapDir, '002')
  const sessions = existsSync(dir001)
    ? readdirSync(dir001).filter(
        (n) => n.startsWith('sess_') || n.startsWith('zcode_') || n.startsWith('claude-')
      )
    : []
  let chapterCount = 0
  const sessionList: { sid: string; title: string; count: number }[] = []
  for (const sid of sessions) {
    const d = join(dir001, sid)
    const files = readdirSync(d).filter(
      (f) => /^(\d{3})-.*\.md$/.test(f) && !f.endsWith('.superseded.md') && !f.startsWith('000-')
    )
    chapterCount += files.length
    const idx = readFileSync(join(d, '000-index.md'), 'utf-8')
    const title = /title:\s*'?(.+?)'?\n/.exec(idx)?.[1] ?? sid
    sessionList.push({ sid, title, count: files.length })
  }

  // Count draft milestones
  let milestoneCount = 0
  const milestones: { title: string; ch: string }[] = []
  if (existsSync(dir002)) {
    for (const name of readdirSync(dir002)) {
      if (!/^m-[^/]+\.md$/.test(name) || name.includes('.bak')) {
        continue
      }
      const raw = readFileSync(join(dir002, name), 'utf-8')
      if (!/^quality: draft$/m.test(raw)) {
        continue
      }
      milestoneCount++
      const title = /^title:\s*(.+)$/m.exec(raw)?.[1] ?? name
      const chs =
        /chapters:\s*\[([^\]]*)\]/
          .exec(raw)?.[1]
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => !Number.isNaN(n)) ?? []
      milestones.push({
        title,
        ch: chs.length ? `Ch.${Math.min(...chs)}-${Math.max(...chs)}` : '—'
      })
    }
  }

  const body = [
    '---',
    'v: 1',
    'kind: roadmap-index',
    `sessions: ${sessions.length}`,
    `milestones: ${milestoneCount}`,
    `chapters: ${chapterCount}`,
    `generatedAt: '${new Date().toISOString()}'`,
    '---',
    '',
    '# Roadmap Index',
    '',
    '## 里程碑时间线',
    ...milestones.map((m) => `- **${m.title}** (${m.ch})`),
    '',
    '## Session 索引',
    ...sessionList.map((s) => `- **${s.title}** (${s.count} 章)`),
    ''
  ].join('\n')
  writeFileSync(join(roadmapDir, 'INDEX.md'), body, 'utf-8')
}
