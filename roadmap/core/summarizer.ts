// One-shot chapter summarizer: spawns `zcode -p` headless in an isolated
// temp cwd, digest delivered via a file the prompt names (argv 32k ceiling),
// strict-JSON reply. Retries [2s,4s], then degrades to a heuristic card
// marked quality=agent-draft + heuristic note — never silent.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export type SummarizerResult =
  | { kind: 'llm'; card: SummarizedChapter }
  | { kind: 'heuristic'; card: SummarizedChapter; reason: string }

export type SeqText = { text: string; seq?: number }

export type SummarizedChapter = {
  title: string
  points: SeqText[]
  decisions: SeqText[]
  artifacts: string[]
  pitfalls: SeqText[]
}

const RETRY_DELAYS_MS = [2000, 4000]

export async function summarizeChapter(args: {
  digest: string
  promptTemplate: string
  zcodeBin?: string
}): Promise<SummarizerResult> {
  const bin = args.zcodeBin ?? 'zcode'
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-summarize-'))
  const digestFile = join(dir, 'digest.txt')
  writeFileSync(digestFile, args.digest, 'utf8')
  const prompt = args.promptTemplate.replace('{{DIGEST_FILE}}', digestFile)
  let lastError = 'unknown error'
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]!)
    }
    try {
      const stdout = await runZcode(bin, prompt, dir)
      const parsed = parseChapterJson(stdout)
      if (parsed) {
        rmSync(dir, { recursive: true, force: true })
        return { kind: 'llm', card: parsed }
      }
      lastError = 'reply carried no parseable chapter JSON'
    } catch (error) {
      lastError = String(error)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  return { kind: 'heuristic', card: heuristicCard(args.digest), reason: lastError }
}

function runZcode(bin: string, prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', prompt], { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => reject(`spawn failed (${bin}): ${String(error)}`))
    child.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve(stdout)
      } else {
        reject(`zcode -p exited ${code}: ${stderr.slice(0, 400) || stdout.slice(0, 200)}`)
      }
    })
    setTimeout(() => {
      child.kill()
      reject('zcode -p timed out after 180s')
    }, 180_000).unref()
  })
}

export function parseChapterJson(stdout: string): SummarizedChapter | null {
  const candidates = [...stdout.matchAll(/\{[\s\S]*\}/g)].map((m) => m[0])
  for (const candidate of candidates.toReversed()) {
    try {
      const parsed = JSON.parse(candidate) as Partial<SummarizedChapter> & {
        points?: (string | { text: string; seq?: number })[]
        decisions?: (string | { text: string; seq?: number })[]
        pitfalls?: (string | { text: string; seq?: number })[]
      }
      if (
        typeof parsed.title === 'string' &&
        Array.isArray(parsed.points) &&
        parsed.points.length > 0
      ) {
        const normalize = (
          items: (string | { text: string; seq?: number })[] | undefined
        ): SeqText[] =>
          (items ?? []).map((item) => (typeof item === 'string' ? { text: item } : item))
        return {
          title: parsed.title,
          points: normalize(parsed.points),
          decisions: normalize(parsed.decisions),
          artifacts: parsed.artifacts ?? [],
          pitfalls: normalize(parsed.pitfalls)
        }
      }
    } catch {
      // try the next {...} block
    }
  }
  return null
}

function heuristicCard(digest: string): SummarizedChapter {
  const humanLines = digest
    .split('\n')
    .filter((line) => line.startsWith('[用户 '))
    .map((line) => line.slice(0, 120))
  return {
    title: '（启发式降级：总结器不可用）',
    points: humanLines
      .slice(0, 5)
      .map((line, i) => ({ text: `要点${i + 1}（原文摘录）：${line}` })),
    decisions: [],
    artifacts: [],
    pitfalls: []
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
