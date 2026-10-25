import { useCallback, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useActiveWorktreeId } from '@/store/selectors'
import { getRuntimePathBasename, resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { detectLanguage } from '@/lib/language-detect'
import { translate } from '@/i18n/i18n'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { RoadmapChapterRow, RoadmapSessionGroup } from './roadmap-panel-data'
import { resolvePitSourcePath } from './roadmap-panel-data'
import { useRoadmapPanelData } from './use-roadmap-panel-data'
import {
  RoadmapEmptyState,
  RoadmapPitsView,
  RoadmapProjectView,
  RoadmapSessionsView
} from './RoadmapPanelViews'

type RoadmapView = 'sessions' | 'project' | 'pits'

const ROADMAP_VIEWS: { id: RoadmapView; labelKey: string; labelDefault: string }[] = [
  {
    id: 'sessions',
    labelKey: 'auto.components.right.sidebar.RoadmapPanel.sessionsView',
    labelDefault: 'Sessions'
  },
  {
    id: 'project',
    labelKey: 'auto.components.right.sidebar.RoadmapPanel.projectView',
    labelDefault: 'Project'
  },
  {
    id: 'pits',
    labelKey: 'auto.components.right.sidebar.RoadmapPanel.pitsView',
    labelDefault: 'Pits'
  }
]

/** Open a roadmap card as a worktree file tab (Explorer's open semantics). */
function openRoadmapFile(filePath: string, relativePath: string, worktreeId: string): void {
  useAppStore.getState().openFile(
    {
      filePath,
      relativePath,
      worktreeId,
      // Cards are discovered on the client-local host; pin local ownership so an
      // active runtime cannot reinterpret the worktree-relative path as remote.
      runtimeEnvironmentId: null,
      language: detectLanguage(filePath),
      mode: 'edit'
    },
    {
      preview: true,
      focusEditor: true,
      suppressActiveRuntimeFallback: true
    }
  )
}

export default function RoadmapPanel(): React.JSX.Element {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const worktreePath = activeWorktree?.path ?? null
  const { loading, error, exists, sessions, pitSections, milestones } =
    useRoadmapPanelData(worktreePath)
  const [view, setView] = useState<RoadmapView>('sessions')
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(() => new Set())

  const toggleSession = useCallback((sessionId: string) => {
    setCollapsedSessions((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }, [])

  const openChapter = useCallback(
    (session: RoadmapSessionGroup, chapter: RoadmapChapterRow) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const relativePath = `.roadmap/001/${session.sessionId}/${chapter.fileName}`
      openRoadmapFile(
        resolveRuntimePath(worktreePath, relativePath),
        relativePath,
        activeWorktreeId
      )
    },
    [activeWorktreeId, worktreePath]
  )

  const openPitSource = useCallback(
    (href: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const absolutePath = resolvePitSourcePath(
        resolveRuntimePath(worktreePath, '.roadmap/pits'),
        href
      )
      openRoadmapFile(absolutePath, absolutePath.slice(worktreePath.length + 1), activeWorktreeId)
    },
    [activeWorktreeId, worktreePath]
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="shrink-0 border-b border-sidebar-border px-2.5 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold text-foreground">
            {translate('auto.components.right.sidebar.RoadmapPanel.title', 'Roadmap')}
          </h2>
          <span className="truncate text-[11px] text-muted-foreground">
            {worktreePath === null
              ? translate('auto.components.right.sidebar.RoadmapPanel.noWorkspace', 'No workspace')
              : sessions.length === 1
                ? translate(
                    'auto.components.right.sidebar.RoadmapPanel.oneSession',
                    '{{value0}} · 1 session',
                    { value0: getRuntimePathBasename(worktreePath) }
                  )
                : translate(
                    'auto.components.right.sidebar.RoadmapPanel.sessionCount',
                    '{{value0}} · {{value1}} sessions',
                    {
                      value0: getRuntimePathBasename(worktreePath),
                      value1: String(sessions.length)
                    }
                  )}
          </span>
        </div>
        <div className="mt-2 rounded-md bg-muted p-0.5">
          <ToggleGroup
            variant="segmented"
            size="xs"
            type="single"
            spacing={1}
            value={view}
            onValueChange={(value) => {
              if (value === 'sessions' || value === 'project' || value === 'pits') {
                setView(value)
              }
            }}
            aria-label={translate(
              'auto.components.right.sidebar.RoadmapPanel.viewAriaLabel',
              'Roadmap view'
            )}
            className="h-6 w-full"
          >
            {ROADMAP_VIEWS.map((option) => (
              <ToggleGroupItem key={option.id} value={option.id} className="min-w-0 flex-1">
                {translate(option.labelKey, option.labelDefault)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {error ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        {worktreePath === null ? (
          <RoadmapEmptyState
            message={translate(
              'auto.components.right.sidebar.RoadmapPanel.noWorkspaceActive',
              'No workspace active'
            )}
          />
        ) : loading && !exists ? (
          <div
            className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground"
            aria-busy="true"
          >
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
            <span>
              {translate('auto.components.right.sidebar.RoadmapPanel.loading', 'Reading roadmap')}
            </span>
          </div>
        ) : !exists ? (
          <RoadmapEmptyState
            message={translate(
              'auto.components.right.sidebar.RoadmapPanel.noRoadmap',
              'No roadmap yet — run `bun roadmap/build.ts <sessionId>` to generate chapter cards'
            )}
          />
        ) : view === 'sessions' ? (
          <RoadmapSessionsView
            sessions={sessions}
            collapsedSessions={collapsedSessions}
            onToggleSession={toggleSession}
            onOpenChapter={openChapter}
          />
        ) : view === 'project' ? (
          <RoadmapProjectView milestones={milestones} />
        ) : (
          <RoadmapPitsView sections={pitSections} onOpenSource={openPitSource} />
        )}
      </div>
    </div>
  )
}
