// Cross-carrier row dedup (zcode handoff, final piece): a resumed conversation
// REPLAYS its history under a new journal id, so the same provider item exists
// as rows under several carriers. The stable identity is the provider item key
// embedded inside itemId — parse it with the shared decoder, never by hand.

import type { JournalRowRef } from './journal-reader'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'

export type RowWithKey = {
  row: JournalRowRef
  /** provider-domain stable key, or null for bookkeeping rows (submission/epoch) */
  providerKey: string | null
  /** revision within the (itemId, revision) upsert chain; -1 when absent */
  revision: number
}

/**
 * Extract the stable provider key + revision from one row. itemId lives at the
 * row top level; `revision` accompanies it in the upsert chain. The legacy
 * carrier prefix (`legacy:zcode:<journalId>:...`) is stripped by the parser's
 * recordId — ai-vault session copies do NOT rewrite itemId, so comparing full
 * itemIds would double-count (zcode handoff pitfall #2).
 */
export function rowIdentity(row: JournalRowRef): RowWithKey {
  let parsedBody: { itemId?: string; revision?: number } | null = null
  try {
    parsedBody = JSON.parse(row.rowJson) as { itemId?: string; revision?: number }
  } catch {
    parsedBody = null
  }
  const itemId = parsedBody?.itemId
  if (typeof itemId !== 'string') {
    return { row, providerKey: null, revision: -1 }
  }
  const identity = parseAgentJournalItemKey(itemId)
  // Only legacy-carried rows expose recordId (the provider-stable inner key);
  // orca-minted submissions and codex/claude rows key on their own fields.
  const providerKey =
    identity && identity.provider === 'legacy'
      ? identity.recordId
      : identity
        ? JSON.stringify(identity)
        : null
  if (!providerKey) {
    return { row, providerKey: null, revision: -1 }
  }
  return {
    row,
    providerKey,
    revision: typeof parsedBody?.revision === 'number' ? (parsedBody.revision as number) : -1
  }
}

/**
 * Deduplicate rows across journal carriers: same provider key -> keep the max
 * revision row (replays re-deliver the same revision chain; do not assume
 * revision numbers are equal across carriers — zcode handoff pitfall #1).
 * Bookkeeping rows without a provider key pass through untouched.
 */
export function dedupRowsAcrossCarriers(rows: JournalRowRef[]): JournalRowRef[] {
  const byKey = new Map<string, RowWithKey>()
  const passthrough: JournalRowRef[] = []
  for (const row of rows) {
    const withKey = rowIdentity(row)
    if (withKey.providerKey === null) {
      passthrough.push(row)
      continue
    }
    const prev = byKey.get(withKey.providerKey)
    if (!prev || withKey.revision >= prev.revision) {
      byKey.set(withKey.providerKey, withKey)
    }
  }
  return [...passthrough, ...[...byKey.values()].map((w) => w.row)]
}
