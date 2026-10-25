import RoadmapPanel from './RoadmapPanel'

/** Right-sidebar host: the roadmap has no focus/search affordances beyond the
 *  panel's own view switcher, so this stays a plain mount (AiVault-style). */
export default function RoadmapSidebarPanel(): React.JSX.Element {
  return <RoadmapPanel />
}
