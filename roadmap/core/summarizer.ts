// One-shot chapter summarizer: spawns `zcode -p` headless in an isolated
// temp cwd, digest delivered via a file the prompt names (argv 32k ceiling),
// strict-JSON reply. Retries [2s,4s], then degrades to a heuristic card
// marked quality=agent-draft + heuristic note — never silent.

import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export type SummarizerResult =
  | { kind: 'llm'; card: SummarizedChapter }
  | { kind: 'heuristic'; card: SummarizedChapter; reason: string }

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
  /** Structured term pairs the model itself declared (primary source for
   * the rolling terminology injection; prose regex is only a fallback). */
  terms?: TermPairOut[]
}

const RETRY_DELAYS_MS = [2000, 4000]

export async function summarizeChapter(args: {
  digest: string
  promptTemplate: string
  /** Stable per-session dir: keeps the child cwd (embedded in the -p system
   * prompt) constant so the provider prefix cache survives across chapters. */
  sessionDir?: string
  digestName?: string
  zcodeBin?: string
}): Promise<SummarizerResult> {
  const bin = args.zcodeBin ?? 'zcode'
  const dir = args.sessionDir ?? mkdtempSync(join(tmpdir(), 'roadmap-summarize-'))
  const digestFile = join(dir, args.digestName ?? `digest-${Date.now()}.txt`)
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
        if (args.sessionDir === undefined) {
          cleanupTempDir(dir)
        }
        return { kind: 'llm', card: parsed }
      }
      lastError = 'reply carried no parseable chapter JSON'
    } catch (error) {
      lastError = String(error)
      if (lastError.includes('timed out')) {
        break // a timeout is a budget problem, not a transient one
      }
    }
  }
  if (args.sessionDir === undefined) {
    cleanupTempDir(dir)
  }
  return { kind: 'heuristic', card: heuristicCard(args.digest), reason: lastError }
}

/** Windows: the exited child's cwd can stay locked briefly (AV/indexer);
 * temp cleanup is best-effort and never fails the summarization. */
function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  } catch {
    // leaked temp dir is acceptable; the OS reclaims it
  }
}

function runZcode(bin: string, prompt: string, cwd: string): Promise<string> {
  const command = resolveZcodeCommand(bin)
  return new Promise((resolve, reject) => {
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
      reject('zcode -p timed out after 420s')
    }, 420_000)
    timer.unref()
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim().length > 0) {
        resolve(stdout)
      } else {
        reject(`zcode -p exited ${code}: ${stderr.slice(0, 400) || stdout.slice(0, 200)}`)
      }
    })
  })
}

let zcodeCommandCache: { cmd: string; prefixArgs: string[] } | null = null

/**
 * On Windows the `zcode` on PATH is a .cmd shim, and Node refuses argv with
 * cmd.exe metacharacters (our CJK prompt is full of them). Resolve the shim
 * to its real JS entry and spawn node on it directly; anywhere else the
 * binary spawns as-is.
 */
function resolveZcodeCommand(bin: string): { cmd: string; prefixArgs: string[] } {
  if (zcodeCommandCache) {
    return zcodeCommandCache
  }
  if (process.platform !== 'win32' || !bin.includes('zcode') || bin.endsWith('.js')) {
    zcodeCommandCache = { cmd: bin, prefixArgs: [] }
    return zcodeCommandCache
  }
  try {
    const shimDir = join(homedir(), 'AppData', 'Roaming', 'npm')
    const jsEntry = join(shimDir, 'node_modules', 'zcode-app-cli', 'bin', 'zcode.js')
    if (existsSync(jsEntry)) {
      zcodeCommandCache = { cmd: 'node', prefixArgs: [jsEntry] }
      return zcodeCommandCache
    }
    console.warn(
      `[roadmap] zcode npm entry not found at ${jsEntry}; falling back to PATH spawn which may fail on Windows`
    )
  } catch {
    // fall through to bare spawn
  }
  zcodeCommandCache = { cmd: bin, prefixArgs: [] }
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
        // Parse-boundary hardening: null/non-object list items are dropped
        // (not only in pitfalls), and newlines are stripped from every
        // free-text field so scalar()/body can never see multi-line junk.
        const normalize = (items: unknown[] | undefined): SeqText[] =>
          (items ?? [])
            .filter(
              (item): item is string | Record<string, unknown> =>
                typeof item === 'string' || (typeof item === 'object' && item !== null)
            )
            .map((item) => {
              if (typeof item === 'string') {
                return { text: item.replace(/\n/g, '') }
              }
              const entry: SeqText = { text: String(item.text ?? '').replace(/\n/g, '') }
              if (typeof item.seq === 'number') {
                entry.seq = item.seq
              }
              if (typeof item.quote === 'string') {
                entry.quote = item.quote
              }
              return entry
            })
            .filter((entry) => entry.text.length > 0)
        const normalizePits = (items: (string | PitfallEntry)[] | undefined): PitfallEntry[] =>
          (items ?? [])
            .filter((item): item is string | PitfallEntry => item !== null && item !== undefined)
            .map((item) => {
              if (typeof item === 'string') {
                return { text: item }
              }
              return {
                text: String(item.text ?? '').replace(/\n/g, ''),
                keywords: Array.isArray(item.keywords)
                  ? item.keywords.filter((k): k is string => typeof k === 'string')
                  : [],
                symptom:
                  typeof item.symptom === 'string' ? item.symptom.replace(/\n/g, '') : undefined,
                fix: typeof item.fix === 'string' ? item.fix.replace(/\n/g, '') : undefined,
                seq: typeof item.seq === 'number' ? item.seq : undefined,
                quote: typeof item.quote === 'string' ? item.quote : undefined
              }
            })
            .filter((pit) => pit.text.length > 0)
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
