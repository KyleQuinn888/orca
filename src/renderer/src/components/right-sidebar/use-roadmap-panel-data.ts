import { useCallback, useEffect, useRef, useState } from 'react'
import {
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../../../shared/cross-platform-path'
import {
  parsePitsKeywords,
  parseProjectIndex,
  parseSessionIndex,
  type RoadmapMilestone,
  type RoadmapPitSection,
  type RoadmapSessionGroup
} from './roadmap-panel-data'

export type RoadmapPanelData = {
  /** True while a scan of the active worktree's `.roadmap/` is in flight. */
  loading: boolean
  error: string | null
  /** False until a `.roadmap/` artifact (session, pits, or INDEX) is found. */
  exists: boolean
  sessions: RoadmapSessionGroup[]
  pitSections: RoadmapPitSection[]
  milestones: RoadmapMilestone[]
  refresh: () => void
}

const ROADMAP_REFRESH_DEBOUNCE_MS = 300

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const result = await window.api.fs.readFile({ filePath })
    return result.isBinary ? null : result.content
  } catch {
    // Missing or unreadable artifacts are normal states, not errors.
    return null
  }
}

async function loadRoadmapData(worktreePath: string): Promise<Omit<RoadmapPanelData, 'refresh'>> {
  const roadmapDir = resolveRuntimePath(worktreePath, '.roadmap')
  const sessionsRoot = resolveRuntimePath(roadmapDir, '001')

  const sessions: RoadmapSessionGroup[] = []
  try {
    const entries = await window.api.fs.readDir({ dirPath: sessionsRoot })
    // Sequential reads keep IPC ordered on huge session counts and let one
    // rejection skip a single session instead of aborting the whole scan.
    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue
      }
      const indexContent = await readTextFile(
        resolveRuntimePath(resolveRuntimePath(sessionsRoot, entry.name), '000-index.md')
      )
      const group = indexContent === null ? null : parseSessionIndex(indexContent)
      if (group) {
        sessions.push(group)
      }
    }
  } catch {
    // No 001 layer yet — sessions stay empty; pits/INDEX may still exist.
  }

  const pitsDir = resolveRuntimePath(roadmapDir, 'pits')
  const pitsContent = await readTextFile(resolveRuntimePath(pitsDir, 'KEYWORDS.md'))
  const pitSections = pitsContent === null ? [] : parsePitsKeywords(pitsContent)

  const projectContent = await readTextFile(resolveRuntimePath(roadmapDir, 'INDEX.md'))
  const milestones = projectContent === null ? [] : parseProjectIndex(projectContent)

  return {
    loading: false,
    error: null,
    exists: sessions.length > 0 || pitSections.length > 0 || milestones.length > 0,
    sessions,
    pitSections,
    milestones
  }
}

/**
 * Read the active worktree's `.roadmap/` layers through the fs bridge and keep
 * them fresh: the worktree watch (re)installed here feeds `onFsChanged`, and
 * payload bursts — a build writing a card wave — collapse into one refresh.
 */
export function useRoadmapPanelData(worktreePath: string | null): RoadmapPanelData {
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<Omit<RoadmapPanelData, 'refresh'>>({
    loading: worktreePath !== null,
    error: null,
    exists: false,
    sessions: [],
    pitSections: [],
    milestones: []
  })
  const refreshTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!worktreePath) {
      setData({
        loading: false,
        error: null,
        exists: false,
        sessions: [],
        pitSections: [],
        milestones: []
      })
      return
    }
    let cancelled = false
    setData((current) => ({ ...current, loading: true }))
    loadRoadmapData(worktreePath)
      .then((next) => {
        if (!cancelled) {
          setData(next)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        setData({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          exists: false,
          sessions: [],
          pitSections: [],
          milestones: []
        })
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, revision])

  useEffect(() => {
    if (!worktreePath) {
      return
    }
    // Why the comparison key: watcher events may carry a different drive-letter
    // case than the stored worktree path on Windows (§4.4 of the watcher design).
    const watchedPathKey = normalizeRuntimePathForComparison(worktreePath)
    // Why install the watch ourselves: card generation happens outside the app
    // (`bun roadmap/build.ts`), so nothing else in the renderer guarantees this
    // worktree is watched while the panel is open.
    void window.api.fs.watchWorktree({ worktreePath }).catch(() => {
      // Watch capacity is bounded; the panel still shows the last successful read.
    })
    const scheduleRefresh = (): void => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null
        setRevision((current) => current + 1)
      }, ROADMAP_REFRESH_DEBOUNCE_MS)
    }
    const unsubscribe = window.api.fs.onFsChanged((payload) => {
      if (normalizeRuntimePathForComparison(payload.worktreePath) !== watchedPathKey) {
        return
      }
      scheduleRefresh()
    })
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      unsubscribe()
      void window.api.fs.unwatchWorktree({ worktreePath }).catch(() => {})
    }
  }, [worktreePath])

  const refresh = useCallback(() => {
    setRevision((current) => current + 1)
  }, [])

  return { ...data, refresh }
}
