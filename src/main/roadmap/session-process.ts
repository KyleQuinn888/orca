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
import { dedupRowsAcrossCarriers } from './row-dedup'

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
  preScope?: SessionIdScope,
  backfill = false
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
  const firstJournalCarrier =
    journalIds.find((jid) => jid !== nativeId) ?? journalIds[0] ?? sessionId
  const workspace = workspacePath ?? deps.getWorkspacePath(firstJournalCarrier)
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

  // Cross-carrier replay dedup (zcode handoff): a resumed conversation replays
  // its full history under the new journal id; the same provider item arrives
  // twice with different carrier prefixes. Dedup by provider key BEFORE any
  // folding, segmentation or cursor math, or everything double-counts.
  rows = dedupRowsAcrossCarriers(rows)

  // Threshold auto-policy (spec §1 L2): candidates accumulate metrics from the
  // same rows WITHOUT advancing the cursor; crossing promotes to eligible and
  // this same trigger then processes from the original cursor.
  if (!isActive(state, nativeId)) {
    // Fold each row at most once: candidates never advance cursors, so a
    // foldedUpTo stamp per carrier prevents re-counting the same range on
    // every trigger (Codex review #7)
    const m = metricsOf(state, nativeId)
    const stamp = sessionState.cursorsByJournal ?? {}
    const folded = new Set(
      Object.keys(stamp).map((k) => `${k}:${stamp[k]!.epoch}:${stamp[k]!.seq}`)
    )
    for (const row of rows) {
      const key = `${row.sessionId}:${row.epoch}:${row.seq}`
      if (folded.has(key)) {
        continue
      }
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

  // Cursor advance: in backfill mode, advance only past chapters that were
  // actually processed; in incremental mode advance past all rows read
  const lastProcessedSeq =
    backfill && cuts.length > 0 ? Math.max(...cuts.map((c) => c.toSeq)) : Infinity
  for (const jid of journalIds) {
    const jRows = rows.filter((r) => r.sessionId === jid && r.seq <= lastProcessedSeq)
    const jLast = jRows.reduce(
      (acc, r) =>
        !acc || r.epoch > acc.epoch || (r.epoch === acc.epoch && r.seq > acc.seq) ? r : acc,
      null as JournalRowRef | null
    )
    if (jLast) {
      setCursorFor(sessionState, jid, { epoch: jLast.epoch, seq: jLast.seq })
    }
  }
  if (journalIds.length === 1 && journalIds[0] === nativeId) {
    const lastRow = rows.findLast((r) => r.seq <= lastProcessedSeq)
    if (lastRow) {
      sessionState.scanCursor = { epoch: lastRow.epoch, seq: lastRow.seq }
    }
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
      db,
      backfill
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
