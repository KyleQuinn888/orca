// Summarizer launcher for the R1 service: spawns zcode -p headless.
// Shared with the A-slice CLI's summarizer but adapted for the main process
// (Electron process, not Bun).

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, homedir } from 'node:os'

// Re-export types from the A-slice (the CLI and service share the same JSON contract)
export type SeqText = { text: string; seq?: number; quote?: string }
export type PitfallEntry = {
  text: string
  keywords?: string[]
  symptom?: string
  fix?: string
  seq?: number
  quote?: string
}
export type TermPairOut = { standard: string; jargon: string }
export type SummarizedChapter = {
  title: string
  points: SeqText[]
  decisions: SeqText[]
  artifacts: string[]
  pitfalls: PitfallEntry[]
  terms?: TermPairOut[]
}
export type SummarizerResult =
  | { kind: 'llm'; card: SummarizedChapter }
  | { kind: 'heuristic'; card: SummarizedChapter; reason: string }

const RETRY_DELAYS_MS = [2000, 4000]
const TIMEOUT_MS = 600_000 // 10 minutes (owner decision: 600s + 1 retry)

export async function summarizeChapter(args: {
  digest: string
  promptTemplate: string
  sessionDir?: string
  digestName?: string
}): Promise<SummarizerResult> {
  const dir = args.sessionDir ?? mkdtempSync(join(tmpdir(), 'roadmap-main-'))
  const digestFile = join(dir, args.digestName ?? `digest-${Date.now()}.txt`)
  writeFileSync(digestFile, args.digest, 'utf8')
  const prompt = args.promptTemplate.replace('{{DIGEST_FILE}}', resolve(digestFile))

  let lastError = 'unknown error'
  let timeouts = 0
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]!)
    }
    try {
      const stdout = await runZcode(prompt, dir)
      const parsed = parseChapterJson(stdout)
      if (parsed) {
        if (args.sessionDir === undefined) {
          cleanupTempDir(dir)
        }
        return { kind: 'llm', card: parsed }
      }
      lastError = 'reply carried no parseable chapter JSON'
    } catch (error) {
      lastError = String(error)
      if (lastError.includes('timed out')) {
        timeouts++
        if (timeouts >= 2) {
          break // second timeout confirms budget, not variance
        }
      }
    }
  }
  if (args.sessionDir === undefined) {
    cleanupTempDir(dir)
  }
  return {
    kind: 'heuristic',
    card: { title: '（降级）', points: [], decisions: [], artifacts: [], pitfalls: [] },
    reason: lastError
  }
}

function runZcode(prompt: string, cwd: string): Promise<string> {
  const command = resolveZcodeCommand()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.cmd, [...command.prefixArgs, '-p', prompt], {
      cwd,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => reject(`spawn failed (${command.cmd}): ${String(error)}`))
    const timer = setTimeout(() => {
      child.kill()
      reject(`zcode -p timed out after ${TIMEOUT_MS / 1000}s`)
    }, TIMEOUT_MS)
    timer.unref()
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim().length > 0) {
        resolvePromise(stdout)
      } else {
        reject(`zcode -p exited ${code}: ${stderr.slice(0, 400) || stdout.slice(0, 200)}`)
      }
    })
  })
}

let zcodeCommandCache: { cmd: string; prefixArgs: string[] } | null = null

function resolveZcodeCommand(): { cmd: string; prefixArgs: string[] } {
  if (zcodeCommandCache) {
    return zcodeCommandCache
  }
  if (process.platform !== 'win32') {
    zcodeCommandCache = { cmd: 'zcode', prefixArgs: [] }
    return zcodeCommandCache
  }
  try {
    const jsEntry = join(
      homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      'zcode-app-cli',
      'bin',
      'zcode.js'
    )
    if (existsSync(jsEntry)) {
      zcodeCommandCache = { cmd: 'node', prefixArgs: [jsEntry] }
      return zcodeCommandCache
    }
  } catch {
    // fall through
  }
  console.warn(
    '[roadmap] zcode npm entry not found; falling back to PATH spawn (may fail on Windows)'
  )
  zcodeCommandCache = { cmd: 'zcode', prefixArgs: [] }
  return zcodeCommandCache
}

export function parseChapterJson(stdout: string): SummarizedChapter | null {
  const candidates = [...stdout.matchAll(/\{[\s\S]*\}/g)].map((m) => m[0])
  for (const candidate of candidates.toReversed()) {
    try {
      const parsed = JSON.parse(candidate) as Partial<SummarizedChapter> & {
        points?: (string | SeqText)[]
        decisions?: (string | SeqText)[]
        pitfalls?: (string | PitfallEntry)[]
        terms?: TermPairOut[]
      }
      if (
        typeof parsed.title === 'string' &&
        Array.isArray(parsed.points) &&
        parsed.points.length > 0
      ) {
        const normalize = (items: (string | SeqText)[] | undefined): SeqText[] =>
          (items ?? [])
            .filter((item): item is string | SeqText => item !== null && item !== undefined)
            .map((item) => {
              if (typeof item === 'string') {
                return { text: item }
              }
              return {
                text: typeof item.text === 'string' ? item.text.replace(/\n/g, '') : '',
                seq: typeof item.seq === 'number' ? item.seq : undefined,
                quote: typeof item.quote === 'string' ? item.quote.replace(/\n/g, '') : undefined
              }
            })
            .filter((p) => p.text.length > 0)
        const normalizePits = (items: (string | PitfallEntry)[] | undefined): PitfallEntry[] =>
          (items ?? [])
            .filter((item): item is string | PitfallEntry => item !== null && item !== undefined)
            .map((item) => {
              if (typeof item === 'string') {
                return { text: item }
              }
              return {
                text: typeof item.text === 'string' ? item.text.replace(/\n/g, '') : '',
                keywords: Array.isArray(item.keywords)
                  ? item.keywords.filter((k): k is string => typeof k === 'string')
                  : [],
                symptom:
                  typeof item.symptom === 'string' ? item.symptom.replace(/\n/g, '') : undefined,
                fix: typeof item.fix === 'string' ? item.fix.replace(/\n/g, '') : undefined,
                seq: typeof item.seq === 'number' ? item.seq : undefined,
                quote: typeof item.quote === 'string' ? item.quote.replace(/\n/g, '') : undefined
              }
            })
            .filter((p) => p.text.length > 0)
        return {
          title: parsed.title.replace(/\n/g, ''),
          points: normalize(parsed.points),
          decisions: normalize(parsed.decisions),
          artifacts: parsed.artifacts ?? [],
          pitfalls: normalizePits(parsed.pitfalls),
          terms: Array.isArray(parsed.terms)
            ? parsed.terms
                .filter((t) => t && typeof t.standard === 'string' && typeof t.jargon === 'string')
                .slice(0, 40)
            : undefined
        }
      }
    } catch {
      // try next
    }
  }
  return null
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  } catch {
    // leaked temp dir is acceptable
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
