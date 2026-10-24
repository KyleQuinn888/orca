// Project-level pit keyword layer (.roadmap/pits/KEYWORDS.md): the agent-facing
// progressive-disclosure surface (vision feature 3.5). Keywords carry BOTH
// standard terminology and the session's own jargon so an agent grepping
// either form hits the pit. Derived file: this session's section is rebuilt
// per run; other sessions' sections survive.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PitfallEntry } from './summarizer'
import type { TuiSession } from './tui-reader'

type PitSource = { sessionId: string; sessionTitle: string; chapter: number; pit: PitfallEntry }

/**
 * Project-level pit keyword layer (.roadmap/pits/KEYWORDS.md): the agent-facing
 * progressive-disclosure surface (vision feature 3.5). Derived file — this
 * session's section is rebuilt on every run, other sessions' sections survive.
 */
export function refreshPitsIndex(
  workspace: string,
  session: TuiSession,
  sources: PitSource[]
): void {
  if (workspace === '') {
    return
  }
  const pitsDir = join(workspace, '.roadmap', 'pits')
  mkdirSync(pitsDir, { recursive: true })
  const path = join(pitsDir, 'KEYWORDS.md')
  let otherSections = ''
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8')
    const sections = existing.split(/\n(?=## )/)
    otherSections = sections
      .filter((s) => !s.includes(`## ${session.id}`))
      .filter((s) => s.trim().length > 0)
      .map((s) => s.trimEnd())
      .join('\n\n')
  }
  const rows = sources.map((s) => {
    const keywords = (s.pit.keywords ?? []).join('、') || s.pit.text.slice(0, 12)
    const symptom = s.pit.symptom ?? ''
    const fix = s.pit.fix ?? ''
    const arrow = symptom && fix ? `${symptom} → ${fix}` : s.pit.text
    return `| ${keywords} | ${arrow} | Ch.${s.chapter} seq ${s.pit.seq ?? '?'} |`
  })
  const section =
    sources.length > 0
      ? [
          `## ${session.id} ${session.title}`,
          '',
          '| 关键词 | 症状 → 解法 | 溯源 |',
          '|---|---|---|',
          ...rows
        ].join('\n')
      : ''
  const header = '# 坑关键词层（派生文件，可整体重建；agent 开工前先扫本表命中关键词）\n'
  const body = [header, otherSections, section].filter((x) => x.trim().length > 0).join('\n\n')
  const next = `${body}\n`
  const tmp = `${path}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, path)
}
