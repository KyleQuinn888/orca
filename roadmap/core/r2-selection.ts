// R2 selection state machine + identity re-resolution — spec r2-ui.md v1.2 §3.
// Chapter identity = session + NNN index (stable across supersede renames);
// milestone identity = m-ULID (matrix path re-keys -> demote to session).

import type { R2Snapshot } from './r2-snapshot'

export type Selection =
  | { level: 'project' }
  | { level: 'session'; sid: string }
  | { level: 'milestone'; sid: string; mid: string }
  | { level: 'chapter'; sid: string; chapter: number }

export const PROJECT: Selection = { level: 'project' }

/**
 * Re-resolve a selection against a new snapshot after a generation change.
 * Returns the (possibly demoted) selection and whether a demotion happened;
 * callers surface a toast when demoted=true (spec §3).
 */
export function reResolve(sel: Selection, next: R2Snapshot): { sel: Selection; demoted: boolean } {
  if (sel.level === 'project') {return { sel, demoted: false }}
  const sidAlive = next.sessions.some((s) => s.id === sel.sid)
  if (!sidAlive) {return { sel: PROJECT, demoted: true }}
  if (sel.level === 'session') {return { sel, demoted: false }}
  if (sel.level === 'milestone') {
    const alive = next.milestones.some((m) => m.id === sel.mid && m.session === sel.sid)
    return alive ? { sel, demoted: false } : { sel: { level: 'session', sid: sel.sid }, demoted: true }
  }
  const chAlive = next.chapters.some((c) => c.session === sel.sid && c.index === sel.chapter)
  return chAlive ? { sel, demoted: false } : { sel: { level: 'session', sid: sel.sid }, demoted: true }
}
