// Milestone parsing / rendering / LLM naming — spec layer-002-003 v7.3
// (v6 rendering kept; chapterSetHash is computed by the fold engine)

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { Chapter, Group } from './fold'

export type ExistingMilestone = {
  file: string
  id: string
  boundaryKey: string
  chapterSetHash: string
  title: string
  chapters: number[]
  session: string
  quality: string
  contentGeneratedAt: string
  summary: string
  outcome: string
  signal: string
}

export function parseExisting(milestonesDir: string): ExistingMilestone[] {
  if (!existsSync(milestonesDir)) {
    return []
  }
  const out: ExistingMilestone[] = []
  for (const name of readdirSync(milestonesDir).filter(
    (n) => n.startsWith('m-') && n.endsWith('.md')
  )) {
    try {
      const text = readFileSync(join(milestonesDir, name), 'utf8')
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
      const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
      out.push({
        file: name,
        id: /id: (.+)/.exec(fm)?.[1]?.trim() ?? '',
        boundaryKey: /boundaryKey: (.+)/.exec(fm)?.[1]?.trim() ?? '',
        chapterSetHash: /chapterSetHash: (.+)/.exec(fm)?.[1]?.trim() ?? '',
        title: /title: (.+)/.exec(fm)?.[1]?.trim() ?? '',
        chapters:
          /chapters: \[([0-9, ]*)\]/
            .exec(fm)?.[1]
            ?.split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => !Number.isNaN(n)) ?? [],
        session: /- session: (.+)/.exec(fm)?.[1]?.trim() ?? '',
        quality: /quality: (.+)/.exec(fm)?.[1]?.trim() ?? '',
        contentGeneratedAt: /contentGeneratedAt: '(.+?)'/.exec(fm)?.[1] ?? '',
        summary: body.match(/## 总结\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? '',
        outcome: body.match(/## 阶段成果\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? '',
        signal: /signal: (.+)/.exec(fm)?.[1]?.trim() ?? ''
      })
    } catch {
      /* skip corrupt */
    }
  }
  return out
}

export type NamedGroup = Group & {
  id: string
  title: string
  summary: string
  outcome: string
  contentGeneratedAt: string
}

export function renderMilestone(ms: NamedGroup, sessionId: string, chapters: Chapter[]): string {
  const chaptersRef = ms.chapters
    .map((idx) => {
      const ch = chapters.find((c) => c.index === idx)
      return `- ${sessionId.slice(0, 20)}… / Ch.${ch?.index}: ${ch?.heading}`
    })
    .join('\n')
  const evidence =
    ms.winner.kind === 'mark'
      ? `cut @firstMsgSeq ${ms.winner.firstMsgSeq}`
      : `${ms.winner.signalType} boundary`
  return `---
v: 1
kind: milestone
id: ${ms.id}
boundaryKey: ${ms.boundaryKey}
chapterSetHash: ${ms.chapterSetHash}
title: ${ms.title}
boundary:
  signal: ${ms.winner.signalType}
  evidence: "${evidence}"
sessions:
  - session: ${sessionId}
    chapters: [${ms.chapters.map((c) => c.index).join(', ')}]
    chapterSlugs:
${ms.chapters.map((idx) => `      - ${chapters.find((c) => c.index === idx)?.slug ?? '?'}`).join('\n')}
time:
  firstTime: '${ms.chapters[0]?.firstTime ?? ''}'
  lastTime: '${ms.chapters.at(-1)?.lastTime ?? ''}'
quality: draft
provenance: llm
contentGeneratedAt: '${ms.contentGeneratedAt}'
fileUpdatedAt: '${new Date().toISOString()}'
---

# ${ms.title}

## 总结
${ms.summary}

## 阶段成果
${ms.outcome}

## 包含章节
${chaptersRef}
`
}

export function renderIndex(results: NamedGroup[], sessionId: string, chapters: Chapter[]): string {
  const timeline = results
    .map((ms) => {
      const first = ms.chapters[0]!.index
      const last = ms.chapters.at(-1)!.index
      return `- **${ms.title}** (Ch.${first}-${last}): ${ms.outcome}`
    })
    .join('\n')
  return `---
v: 1
kind: roadmap-index
sessions: 1
milestones: ${results.length}
chapters: ${chapters.length}
generatedAt: '${new Date().toISOString()}'
---

# Roadmap Index

> 使用指南：先看里程碑时间线；需要细节读 .roadmap/002/m-*.md；
> 具体章节读 .roadmap/001/<session>/NNN-*.md；开工前扫 .roadmap/pits/KEYWORDS.md。
> 时间线记录历史决策，不代表当前分支状态。

## 里程碑时间线
${timeline}

## Session 索引
| Session | 章节数 | 时间跨度 | 标题 |
|---|---|---|---|
| ${sessionId.slice(0, 20)}… | ${chapters.length} | ${chapters[0]?.firstTime.slice(0, 10)} → ${chapters.at(-1)?.lastTime.slice(0, 10)} | (见会话索引) |
`
}

/** One zcode -p spawn names all groups needing it (stable cwd for prompt cache). */
export async function llmName(
  groups: { group: Group; spanHint: string }[],
  sessionId: string
): Promise<{ title: string; summary: string; outcome: string }[]> {
  const summaries = groups
    .map(({ group, spanHint }, gi) => {
      const chList = group.chapters.map((c) => `Ch.${c.index} ${c.heading}`).join('\n  ')
      const pts = group.chapters
        .map((c) => c.points[0] ?? '')
        .filter(Boolean)
        .join('\n  ')
      return `### Group ${gi + 1}${spanHint}\n${chList}\nKey points:\n  ${pts}`
    })
    .join('\n\n')

  const prompt = `你是项目历史分析师。以下是一个 Session 的章节分组（边界已确定性决定），请为每组命名和总结。

会话: ${sessionId}

${summaries}

输出严格 JSON：
{"milestones": [{"title": "...", "summary": "...", "outcome": "..."}]}

规则：
- title: 标准学科术语，动词开头，≤40字
- summary: 2-3句，概括这组做了什么
- outcome: 一句话结论/交付物
- 数组长度必须等于分组数量（${groups.length}组）`

  const tmp = mkdtempSync(join(tmpdir(), 'roadmap-name-'))
  try {
    const zcodeJs = join(
      homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      'zcode-app-cli',
      'bin',
      'zcode.js'
    )
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', [zcodeJs, '-p', prompt], { cwd: tmp, windowsHide: true })
      let out = ''
      child.stdout.on('data', (c) => {
        out += c
      })
      child.stderr.on('data', () => {})
      child.on('close', (code) =>
        code === 0 ? resolve(out) : reject(new Error(`zcode exited ${code}`))
      )
      setTimeout(() => {
        child.kill()
        reject(new Error('timeout'))
      }, 600_000).unref()
    })
    const jsonMatch = stdout.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('no JSON in LLM output')
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      milestones: { title: string; summary: string; outcome: string }[]
    }
    if (parsed.milestones.length !== groups.length) {
      throw new Error(`expected ${groups.length} milestones, got ${parsed.milestones.length}`)
    }
    return parsed.milestones
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ok */
    }
  }
}
