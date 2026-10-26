// R2 shared state store — single source of truth for the roadmap sidebar and
// the project canvas (spec r2-ui.md v1.2 §0/§3/§4). Snapshot loads keep the
// last generation-consistent state when the aggregation is mid-rewrite.

import { create } from 'zustand'
import { resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { buildSnapshot, type R2Snapshot } from '../../../../../roadmap/core/r2-snapshot'
import { deriveRelations, type Relations } from '../../../../../roadmap/core/r2-chains'
import { PROJECT, reResolve, type Selection } from '../../../../../roadmap/core/r2-selection'

export type RoadmapR2WorktreeState = {
  loading: boolean
  error: string | null
  exists: boolean
  /** Last generation-consistent snapshot; kept across mid-rewrite refreshes. */
  snapshot: R2Snapshot | null
  relations: Relations | null
}

type RoadmapR2Store = {
  byWorktree: Record<string, RoadmapR2WorktreeState>
  revisionByWorktree: Record<string, number>
  selection: Selection
  expandedSid: string | null
  treeOpen: Record<string, boolean>
  treeMsOpen: Record<string, boolean>
  sidebarView: 'sessions' | 'pits'
  select: (sel: Selection) => void
  setExpandedSid: (sid: string | null) => void
  toggleTree: (sid: string) => void
  toggleTreeMs: (key: string) => void
  setSidebarView: (view: 'sessions' | 'pits') => void
  ensureTreeOpen: (sid: string, mid?: string) => void
  refresh: (worktreePath: string) => void
  loadNow: (worktreePath: string) => Promise<void>
}

const EMPTY: RoadmapR2WorktreeState = { loading: false, error: null, exists: false, snapshot: null, relations: null }

async function readText(filePath: string): Promise<string | null> {
  try {
    const result = await window.api.fs.readFile({ filePath })
    return result.isBinary ? null : result.content
  } catch {
    return null
  }
}

/** Collect the .roadmap/ layers into the core FileMap (posix-relative keys). */
export async function collectRoadmapFileMap(worktreePath: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const root = resolveRuntimePath(worktreePath, '.roadmap')
  const push = (rel: string, content: string): void => {
    files.set(rel.split('\\').join('/'), content)
  }
  const index = await readText(resolveRuntimePath(root, 'INDEX.md'))
  if (index !== null) {
    push('INDEX.md', index)
  }
  const dirs: [string, string][] = [
    ['001', '001'],
    ['002', '002'],
    ['pits', 'pits']
  ]
  for (const [dir, prefix] of dirs) {
    try {
      const entries = await window.api.fs.readDir({ dirPath: resolveRuntimePath(root, dir) })
      for (const entry of entries) {
        if (entry.isDirectory) {
          // 001/<sid>/NNN-*.md
          try {
            const sub = await window.api.fs.readDir({
              dirPath: resolveRuntimePath(resolveRuntimePath(root, dir), entry.name)
            })
            for (const f of sub) {
              if (f.isDirectory || !/\.(md|json)$/.test(f.name) || f.name.includes('.bak')) {
                continue
              }
              const content = await readText(
                resolveRuntimePath(resolveRuntimePath(resolveRuntimePath(root, dir), entry.name), f.name)
              )
              if (content !== null) {
                push(`${prefix}/${entry.name}/${f.name}`, content)
              }
            }
          } catch {
            // unreadable session dir — skip
          }
        } else if (/\.(md|json)$/.test(entry.name) && !entry.name.includes('.bak')) {
          const content = await readText(resolveRuntimePath(resolveRuntimePath(root, dir), entry.name))
          if (content !== null) {
            push(`${prefix}/${entry.name}`, content)
          }
        }
      }
    } catch {
      // layer absent — normal
    }
  }
  return files
}

function applySnapshot(state: RoadmapR2Store, worktreePath: string, result: ReturnType<typeof buildSnapshot>): Partial<RoadmapR2Store> {
  if (!result.ok || !result.snapshot) {
    // Generation mismatch mid-rewrite: keep previous snapshot, surface as loading note.
    const prev = state.byWorktree[worktreePath] ?? EMPTY
    return {
      byWorktree: {
        ...state.byWorktree,
        [worktreePath]: { ...prev, loading: false, exists: prev.exists }
      }
    }
  }
  const snapshot = result.snapshot
  const resolved = reResolve(state.selection, snapshot)
  return {
    byWorktree: {
      ...state.byWorktree,
      [worktreePath]: {
        loading: false,
        error: null,
        exists: true,
        snapshot,
        relations: deriveRelations(snapshot)
      }
    },
    ...(resolved.demoted ? { selection: resolved.sel } : {})
  }
}

export const useRoadmapR2 = create<RoadmapR2Store>((set, get) => ({
  byWorktree: {},
  revisionByWorktree: {},
  selection: PROJECT,
  expandedSid: null,
  treeOpen: {},
  treeMsOpen: {},
  sidebarView: 'sessions',
  select: (sel) => {
    set({ selection: sel })
    if (sel.level === 'chapter' || sel.level === 'milestone' || sel.level === 'session') {
      set({ sidebarView: 'sessions' })
    }
  },
  setExpandedSid: (sid) => {
    set({ expandedSid: sid })
  },
  toggleTree: (sid) => {
    set((s) => ({ treeOpen: { ...s.treeOpen, [sid]: !(s.treeOpen[sid] ?? true) } }))
  },
  toggleTreeMs: (key) => {
    set((s) => ({ treeMsOpen: { ...s.treeMsOpen, [key]: !(s.treeMsOpen[key] ?? false) } }))
  },
  setSidebarView: (view) => {
    set({ sidebarView: view })
  },
  ensureTreeOpen: (sid, mid) => {
    const s = get()
    const patch: Partial<RoadmapR2Store> = {}
    if (!(s.treeOpen[sid] ?? true)) {
      patch.treeOpen = { ...s.treeOpen, [sid]: true }
    }
    if (mid && !(s.treeMsOpen[`${sid}/${mid}`] ?? false)) {
      patch.treeMsOpen = { ...s.treeMsOpen, [`${sid}/${mid}`]: true }
    }
    if (Object.keys(patch).length > 0) {
      set(patch)
    }
  },
  refresh: (worktreePath) => {
    set((s) => ({
      revisionByWorktree: { ...s.revisionByWorktree, [worktreePath]: (s.revisionByWorktree[worktreePath] ?? 0) + 1 }
    }))
    void get().loadNow(worktreePath)
  },
  loadNow: async (worktreePath) => {
    set((s) => ({
      byWorktree: {
        ...s.byWorktree,
        [worktreePath]: { ...(s.byWorktree[worktreePath] ?? EMPTY), loading: true }
      }
    }))
    try {
      const files = await collectRoadmapFileMap(worktreePath)
      const result = buildSnapshot(files)
      set((s) => applySnapshot(s, worktreePath, result))
    } catch (error) {
      set((s) => ({
        byWorktree: {
          ...s.byWorktree,
          [worktreePath]: {
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            exists: false,
            snapshot: null,
            relations: null
          }
        }
      }))
    }
  }
}))

export function roadmapR2State(path: string): RoadmapR2WorktreeState {
  return useRoadmapR2.getState().byWorktree[path] ?? EMPTY
}
