// Per-session processing core split out of roadmap-service (file-size lint):
// row reading across journal carriers, threshold folding, segmentation and
// chapter writes. All state keys live in the provider-native id domain.

import type { RoadmapServiceDeps } from './roadmap-service'
import type { RoadmapStateV2 } from './roadmap-store'
import {
  cursorFor,
  getOrCreateSession,
  isActive,
  isTerminal,
  metricsOf,
  setCursorFor,
  setPolicy
} from './roadmap-store'
import type { JournalRowRef, OpenChapter } from './journal-reader'
import { DEFAULT_SEGMENTATION_CONFIG, flushOpenChapter, segmentRows } from './journal-reader'
import { countExistingChapters, readRowsAfterCursor, readRowsInRange } from './journal-row-io'
import { parseRow } from './journal-row-parse'
import { crossesThreshold, foldRowsIntoMetrics } from './session-threshold'
import { saveStateSafe, summarizeAndWrite } from './chapter-pipeline'
import { scopeFor, type SessionIdScope } from './session-id-bridge'

export type ProcessCtx = {
  deps: RoadmapServiceDeps
  state: RoadmapStateV2
  promptTemplate: string
  openChapters: Map<string, OpenChapter | null>
}

export async function processSessionInner(
  ctx: ProcessCtx,
  sessionId: string,
  _trigger: string,
  preScope?: SessionIdScope
): Promise<void> {
  const { deps, state, promptTemplate, openChapters } = ctx
  // Id bridge: state/artifacts key by the provider-native id; rows live under
  // journal ids. Auto triggers arrive as journal ids and reverse-resolve.
  const scope =
    preScope ?? scopeFor(deps.getUserDataDir(), sessionId, deps.getWorkspacePath(sessionId))
  const { nativeId, journalIds, workspacePath } = scope
  const db = deps.getJournalDb(sessionId)
  if (!db) {
    return
  }
  const workspace = workspacePath ?? deps.getWorkspacePath(journalIds[0] ?? sessionId)
  if (!workspace) {
    return
  }
  const sessionState = getOrCreateSession(state, nativeId)

  // Read new rows since each carrier's own cursor
  let rows: JournalRowRef[] = []
  for (const jid of journalIds) {
    const jRows = readRowsAfterCursor(db, jid, cursorFor(sessionState, jid, nativeId))
    if (jRows.length > 0) {
      rows = rows.concat(jRows)
    }
  }
  if (rows.length === 0) {
    return
  }

  // Threshold auto-policy (spec §1 L2): candidates accumulate metrics from the
  // same rows WITHOUT advancing the cursor; crossing promotes to eligible and
  // this same trigger then processes from the original cursor.
  if (!isActive(state, nativeId)) {
    const m = metricsOf(state, nativeId)
    for (const row of rows) {
      const parsed = parseRow(row.rowJson)
      if (parsed) {
        foldRowsIntoMetrics(m, [parsed])
      }
    }
    if (crossesThreshold(m)) {
      setPolicy(state, nativeId, 'eligible')
      saveStateSafe(deps, state)
    } else {
      saveStateSafe(deps, state) // persist metrics incrementally
      return
    }
  }

  // Cross-carrier ordering: (ts, epoch, seq) keeps segmentation stable when a
  // conversation resumes under a new journal id
  rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.epoch.localeCompare(b.epoch) || a.seq - b.seq)

  // Segment; artifacts and the open-chapter slot key by the native id
  const open = openChapters.get(nativeId) ?? null
  const chapterIndex = countExistingChapters(workspace, nativeId) + 1
  const { cuts, open: newOpen } = segmentRows(
    nativeId,
    rows,
    open,
    DEFAULT_SEGMENTATION_CONFIG,
    chapterIndex
  )
  openChapters.set(nativeId, newOpen)

  // Advance each carrier's cursor to its own last row; single legacy carriers
  // also update the shared cursor
  for (const jid of journalIds) {
    const jLast = rows.findLast((r) => r.sessionId === jid)
    if (jLast) {
      setCursorFor(sessionState, jid, { epoch: jLast.epoch, seq: jLast.seq })
    }
  }
  if (journalIds.length === 1 && journalIds[0] === nativeId) {
    const lastRow = rows.at(-1)!
    sessionState.scanCursor = { epoch: lastRow.epoch, seq: lastRow.seq }
  }

  // Process cuts (chapter closures)
  for (const cut of cuts) {
    // Publish-point recheck: exclusion/deletion requested mid-flight discards
    // this chapter without writing (spec §2 M4 ruling)
    if (isTerminal(state, nativeId)) {
      return
    }
    await summarizeAndWrite(
      deps,
      state,
      promptTemplate,
      nativeId,
      workspace,
      cut,
      rows,
      sessionState,
      db
    )
  }
}

export async function flushSessionInner(ctx: ProcessCtx, sessionId: string): Promise<void> {
  const { deps, state, promptTemplate, openChapters } = ctx
  const scope = scopeFor(deps.getUserDataDir(), sessionId, deps.getWorkspacePath(sessionId))
  const open = openChapters.get(scope.nativeId)
  if (!open || open.terminalTurns === 0) {
    return
  }
  const workspace = scope.workspacePath ?? deps.getWorkspacePath(sessionId)
  if (!workspace) {
    return
  }
  const sessionState = getOrCreateSession(state, scope.nativeId)
  const db = deps.getJournalDb(sessionId)
  if (!db) {
    return
  }
  const chapterIndex = countExistingChapters(workspace, scope.nativeId) + 1
  const flushCut = flushOpenChapter(sessionId, open, chapterIndex)
  if (flushCut) {
    openChapters.set(scope.nativeId, null)
    const rows = readRowsInRange(db, sessionId, flushCut.epoch, flushCut.fromSeq, flushCut.toSeq)
    await summarizeAndWrite(
      deps,
      state,
      promptTemplate,
      scope.nativeId,
      workspace,
      flushCut,
      rows,
      sessionState,
      db
    )
  }
}
