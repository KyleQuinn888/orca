import type React from 'react'
import { Check, ChevronRight, Milestone } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  RoadmapChapterRow,
  RoadmapMilestone,
  RoadmapPitRow,
  RoadmapPitSection,
  RoadmapSessionGroup
} from './roadmap-panel-data'

export function RoadmapEmptyState({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <Milestone className="size-7 text-muted-foreground opacity-50" />
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  )
}

/** Collapsible group band — mirrors the AI Vault group header affordance. */
function RoadmapGroupHeader({
  label,
  count,
  collapsed,
  onToggle
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center gap-2 border-y border-sidebar-border bg-sidebar-accent/60 px-3 text-left text-xs font-semibold text-foreground transition-colors hover:bg-sidebar-accent"
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-foreground/80 transition-transform',
          !collapsed && 'rotate-90'
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="rounded-md border border-sidebar-border bg-background px-2 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-foreground shadow-xs">
        {count}
      </span>
    </button>
  )
}

/** Static section band (no disclosure) — used where rows are not collapsible. */
function RoadmapSectionHeader({
  label,
  count
}: {
  label: string
  count: number
}): React.JSX.Element {
  return (
    <div className="flex h-8 w-full items-center gap-2 border-y border-sidebar-border bg-sidebar-accent/60 px-3 text-xs font-semibold text-foreground">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="rounded-md border border-sidebar-border bg-background px-2 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-foreground shadow-xs">
        {count}
      </span>
    </div>
  )
}

export function RoadmapSessionsView({
  sessions,
  collapsedSessions,
  onToggleSession,
  onOpenChapter
}: {
  sessions: readonly RoadmapSessionGroup[]
  collapsedSessions: ReadonlySet<string>
  onToggleSession: (sessionId: string) => void
  onOpenChapter: (session: RoadmapSessionGroup, chapter: RoadmapChapterRow) => void
}): React.JSX.Element {
  if (sessions.length === 0) {
    return (
      <RoadmapEmptyState
        message={translate(
          'auto.components.right.sidebar.RoadmapPanel.noSessions',
          'No session chapters yet'
        )}
      />
    )
  }
  return (
    <div className="pb-2">
      {sessions.map((session) => {
        const collapsed = collapsedSessions.has(session.sessionId)
        return (
          <section key={session.sessionId} className="mt-2 first:mt-0">
            <RoadmapGroupHeader
              label={session.title}
              count={session.chapters.length}
              collapsed={collapsed}
              onToggle={() => onToggleSession(session.sessionId)}
            />
            {!collapsed &&
              session.chapters.map((chapter) => (
                <RoadmapChapterRowView
                  key={`${session.sessionId}:${chapter.fileName}`}
                  chapter={chapter}
                  onOpen={() => onOpenChapter(session, chapter)}
                />
              ))}
          </section>
        )
      })}
    </div>
  )
}

function RoadmapChapterRowView({
  chapter,
  onOpen
}: {
  chapter: RoadmapChapterRow
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={onOpen}
    >
      <span className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {translate('auto.components.right.sidebar.RoadmapPanel.chapterLabel', 'Ch.{{value0}}', {
            value0: chapter.index
          })}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{chapter.title}</span>
        <span className="max-w-24 shrink-0 truncate rounded-md border border-sidebar-border bg-background px-1.5 py-0.5 text-2xs font-medium leading-none text-muted-foreground">
          {chapter.status}
        </span>
      </span>
      <span className="flex items-center gap-2 font-mono text-2xs text-muted-foreground">
        <span className="truncate tabular-nums">{chapter.seqRange}</span>
        <span aria-hidden>·</span>
        <span className="truncate tabular-nums">{chapter.time}</span>
      </span>
    </button>
  )
}

export function RoadmapProjectView({
  milestones
}: {
  milestones: readonly RoadmapMilestone[]
}): React.JSX.Element {
  if (milestones.length === 0) {
    return (
      <RoadmapEmptyState
        message={translate(
          'auto.components.right.sidebar.RoadmapPanel.noProjectHistory',
          'No project history yet — chapters accumulate per session'
        )}
      />
    )
  }
  return (
    <div className="pb-2">
      {milestones.map((milestone, index) => (
        <section
          key={`${index}:${milestone.title}`}
          className="border-b border-sidebar-border px-3 py-2 last:border-b-0"
        >
          <h3 className="text-xs font-medium text-foreground">{milestone.title}</h3>
          {milestone.lines.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {milestone.lines.map((line, lineIndex) => (
                <li
                  key={lineIndex}
                  className="whitespace-pre-wrap break-words text-2xs text-muted-foreground"
                >
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  )
}

export function RoadmapPitsView({
  sections,
  onOpenSource
}: {
  sections: readonly RoadmapPitSection[]
  onOpenSource: (href: string, pitId?: string) => void
}): React.JSX.Element {
  if (sections.length === 0) {
    return (
      <RoadmapEmptyState
        message={translate(
          'auto.components.right.sidebar.RoadmapPanel.noPits',
          'No pitfalls recorded yet'
        )}
      />
    )
  }
  return (
    <div className="pb-2">
      {sections.map((section) => (
        <section key={section.sessionId} className="mt-2 first:mt-0">
          <RoadmapSectionHeader label={section.title} count={section.rows.length} />
          {section.rows.map((row, index) => (
            <RoadmapPitRowView
              key={`${section.sessionId}:${index}`}
              row={row}
              onOpenSource={onOpenSource}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

function RoadmapPitRowView({
  row,
  onOpenSource
}: {
  row: RoadmapPitRow
  onOpenSource: (href: string, pitId?: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 px-3 py-1.5">
      {row.verified ? (
        <Check
          role="img"
          className="mt-0.5 size-3 shrink-0 text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.RoadmapPanel.pitVerified',
            'Verified against the source'
          )}
        />
      ) : (
        <span
          role="img"
          title={translate(
            'auto.components.right.sidebar.RoadmapPanel.pitUnverified',
            'Not verified yet'
          )}
          className="mt-0.5 size-3 shrink-0 text-center text-2xs leading-3 text-muted-foreground/60"
        >
          –
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="break-words text-xs font-medium text-foreground">{row.keywords}</p>
        <p className="mt-0.5 break-words text-2xs text-muted-foreground">{row.resolution}</p>
        {row.sourceHref ? (
          <button
            type="button"
            className="mt-0.5 max-w-full truncate font-mono text-2xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpenSource(row.sourceHref ?? '', row.pitId ?? undefined)}
          >
            {row.sourceLabel}
            {row.sourceDetail ? ` ${row.sourceDetail}` : ''}
          </button>
        ) : (
          <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
            {row.sourceLabel}
            {row.sourceDetail ? ` ${row.sourceDetail}` : ''}
          </p>
        )}
      </div>
    </div>
  )
}
