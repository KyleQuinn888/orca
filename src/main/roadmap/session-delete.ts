// Session artifact deletion (spec session-enablement v1.3 §3 + v1.2 amendments):
// intent-first, idempotent, cross-process-safe via AggregateLock, startup-resumable.

import { existsSync, readFileSync, renameSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AggregateLock } from '../../../roadmap/aggregation/aggregate-lock'
import { rebuildPitsIndex } from '../../../roadmap/core/pits-index'

export type DeleteDeps = {
  getWorkspacePath: (sessionId: string) => string | null
  getUserDataDir: () => string
  /** Optional bridge: native id -> workspace when the journal lookup misses. */
  resolveWorkspaceForNative?: (nativeId: string) => string | null
}

export type DeleteOutcome = { ok: boolean; error?: string }

const SID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Delete one session's biography artifacts. Idempotent: safe to re-run
 * (startup reconciliation resumes pending deletions the same way).
 *
 * Order (spec §3): caller persists the `deleting` intent BEFORE calling; this
 * function then takes the cross-process AggregateLock, removes 001/<sid>,
 * supersedes the session's 002 milestone cards, rebuilds INDEX + pits, and the
 * caller writes the `deleted` tombstone afterwards.
 */
export async function deleteSessionArtifacts(
  deps: DeleteDeps,
  sessionId: string
): Promise<DeleteOutcome> {
  if (!SID_RE.test(sessionId)) {
    return { ok: false, error: 'invalid session id' }
  }
  // Native-id callers (UI delete entry) resolve through the id bridge; journal
  // ids keep the direct journal lookup (zcode handoff: fast chain only here).
  let workspace = deps.getWorkspacePath(sessionId)
  if (!workspace && deps.resolveWorkspaceForNative) {
    workspace = deps.resolveWorkspaceForNative(sessionId)
  }
  if (!workspace) {
    // spec §3.3: workspace unresolvable -> refuse, deletion stays pending
    return { ok: false, error: 'workspace unavailable' }
  }
  const roadmapDir = join(workspace, '.roadmap')
  const dir002 = join(roadmapDir, '002')
  const sessionDir = join(roadmapDir, '001', sessionId)
  if (basename(sessionDir) !== sessionId) {
    return { ok: false, error: 'path validation failed' }
  }

  let lock: AggregateLock
  try {
    lock = AggregateLock.acquire(dir002)
  } catch (e) {
    // Lock held (e.g. CLI aggregation): retry later — never force-take (spec B6).
    return { ok: false, error: e instanceof Error ? e.message : 'aggregate lock held' }
  }
  try {
    // 1. remove chapter cards (missing dir is fine — idempotent resume)
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true })
    }
    // 2. supersede this session's 002 milestone cards (draft -> superseded);
    //    R2 reads only draft cards, so the session vanishes from every surface
    if (existsSync(dir002)) {
      for (const name of listMCards(dir002)) {
        supersedeIfOwned(join(dir002, name), sessionId)
      }
    }
    // 3. rebuild workspace-level projections: workspace INDEX.md (from remaining
    // draft m-cards + active chapter counts — the R2 snapshot's generation check
    // depends on these numbers agreeing) and the pits index
    try {
      rebuildWorkspaceIndex(roadmapDir)
      rebuildPitsIndex(workspace)
    } catch (e) {
      // projections stale but artifacts gone; reconciliation re-runs this
      return {
        ok: false,
        error: `projection rebuild failed: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    return { ok: true }
  } finally {
    lock.release()
  }
}

function listMCards(dir002: string): string[] {
  try {
    return readdirSync(dir002).filter((n) => /^m-[^/]+\.md$/.test(n) && !n.includes('.bak'))
  } catch {
    return []
  }
}

function supersedeIfOwned(cardPath: string, sessionId: string): void {
  try {
    const raw = readFileSync(cardPath, 'utf-8')
    const m = /^---\n([\s\S]*?)\n---/.exec(raw)
    if (!m || !m[1].includes(`session: ${sessionId}`)) {
      return
    }
    if (!/^quality: draft$/m.test(m[1])) {
      return // already superseded or non-draft
    }
    const next = raw.replace(/^quality: draft$/m, 'quality: superseded')
    if (next !== raw) {
      const tmp = `${cardPath}.tmp`
      writeFileSync(tmp, next, 'utf-8')
      renameSync(tmp, cardPath)
    }
  } catch {
    // unreadable card: leave it; aggregation reconciles later
  }
}

/** Workspace INDEX.md rebuilt from what remains on disk (zero-LLM, like aggregate Step 5). */
function rebuildWorkspaceIndex(roadmapDir: string): void {
  const dir001 = join(roadmapDir, '001')
  const dir002 = join(roadmapDir, '002')
  const sessions = existsSync(dir001)
    ? readdirSync(dir001).filter((n) => SID_RE.test(n) && n !== 'milestones')
    : []
  let chapters = 0
  for (const sid of sessions) {
    const d = join(dir001, sid)
    chapters += readdirSync(d).filter(
      (n) => /^\d{3}-.*\.md$/.test(n) && !n.endsWith('.superseded.md') && !n.startsWith('000-')
    ).length
  }
  const milestones: { title: string; ch: string; summary: string }[] = []
  if (existsSync(dir002)) {
    for (const name of readdirSync(dir002).filter(
      (n) => /^m-[^/]+\.md$/.test(n) && !n.includes('.bak')
    )) {
      const raw = readFileSync(join(dir002, name), 'utf-8')
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
      if (!fm || !/^quality: draft$/m.test(fm[1])) {
        continue
      }
      const title = /^title: (.+)$/m.exec(fm[1])?.[1] ?? name
      const chs =
        /chapters: \[([^\]]*)\]/
          .exec(fm[1])?.[1]
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => !Number.isNaN(n)) ?? []
      const summary = (fm[1].match(/^summary: (.+)$/m)?.[1] ?? '').slice(0, 80)
      milestones.push({
        title,
        ch: chs.length ? `Ch.${Math.min(...chs)}-${Math.max(...chs)}` : '—',
        summary
      })
    }
  }
  const body = [
    '---',
    'v: 1',
    'kind: roadmap-index',
    `sessions: ${sessions.length}`,
    `milestones: ${milestones.length}`,
    `chapters: ${chapters}`,
    `generatedAt: '${new Date().toISOString()}'`,
    '---',
    '',
    '# Roadmap Index',
    '',
    '## 里程碑时间线',
    ...milestones.map((m) => `- **${m.title}** (${m.ch}): ${m.summary}`),
    ''
  ].join('\n')
  writeFileSync(join(roadmapDir, 'INDEX.md'), body, 'utf-8')
}
