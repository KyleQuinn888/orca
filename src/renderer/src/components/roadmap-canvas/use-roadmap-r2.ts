// Loader hook for the R2 shared store: initial load + worktree watch with the
// 300ms debounce the panel already uses (spec r2-ui.md v1.2 §5).

import { useEffect } from 'react'
import {
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../../../shared/cross-platform-path'
import { useRoadmapR2 as useRoadmapR2Store, type RoadmapR2WorktreeState } from './roadmap-r2-store'

const REFRESH_DEBOUNCE_MS = 300

export function useRoadmapR2(worktreePath: string | null): RoadmapR2WorktreeState & { refresh: () => void } {
  const state =
    useRoadmapR2Store((s) => s.byWorktree[worktreePath ?? '']) ?? {
      loading: false,
      error: null,
      exists: false,
      snapshot: null,
      relations: null
    }
  const revision = useRoadmapR2Store((s) => s.revisionByWorktree[worktreePath ?? ''] ?? 0)
  void revision

  useEffect(() => {
    if (!worktreePath) {
      return
    }
    void useRoadmapR2Store.getState().loadNow(worktreePath)
  }, [worktreePath, revision])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- revision tracked below via subscription

  useEffect(() => {
    if (!worktreePath) {
      return
    }
    const watchedPathKey = normalizeRuntimePathForComparison(worktreePath)
    void window.api.fs.watchWorktree({ worktreePath }).catch(() => {})
    let timer: number | null = null
    const unsubscribe = window.api.fs.onFsChanged((payload) => {
      if (normalizeRuntimePathForComparison(payload.worktreePath) !== watchedPathKey) {
        return
      }
      if (timer !== null) {
        window.clearTimeout(timer)
      }
      timer = window.setTimeout(() => {
        timer = null
        void useRoadmapR2Store.getState().loadNow(worktreePath)
      }, REFRESH_DEBOUNCE_MS)
    })
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer)
      }
      unsubscribe()
      void window.api.fs.unwatchWorktree({ worktreePath }).catch(() => {})
    }
  }, [worktreePath])

  return {
    ...state,
    refresh: () => {
      if (worktreePath) {
        useRoadmapR2Store.getState().refresh(worktreePath)
      }
    }
  }
}

/** Canvas panels know the worktree id; resolve its path with this selector helper. */
export function roadmapPathOf(worktrees: { id: string; path: string }[], worktreeId: string): string | null {
  return worktrees.find((w) => w.id === worktreeId)?.path ?? null
}

export function roadmapDirName(worktreePath: string): string {
  return resolveRuntimePath(worktreePath, '.roadmap')
}
