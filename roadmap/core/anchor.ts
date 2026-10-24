// Evidence anchors for roadmap cards (schema v1, S0-S6 adopted 2026-10-24).
// An anchor points at one durable row in a source DB so a card claim stays
// one hop verifiable; contentHash pins the row bytes so schema drift is detectable.

import { createHash } from 'node:crypto'

export type AnchorSource = 'zcode-tui-sqlite' | 'orca-journal'

export type AnchorOrigin =
  | { db: 'zcode-tui-sqlite'; path: string }
  | { db: 'orca-journal'; path: string; profile: string }

export type Evidence = {
  claim: string
  source: AnchorSource
  origin: AnchorOrigin
  /** TUI: message row id. Journal: journal row identity (sessionId@epoch:seq). */
  ref: string
  seq: number
  /** sha256 over the hashed object (see hashOf), first 16 hex chars. */
  contentHash: string
  /** S4a: names what contentHash covers so a schema migration can recompute. */
  hashOf: 'tui-message-data' | 'journal-row-json'
}

export function hashContent(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16)
}

export function tuiEvidence(
  claim: string,
  origin: { path: string },
  message: { id: string; seq: number; data: unknown }
): Evidence {
  return {
    claim,
    source: 'zcode-tui-sqlite',
    origin: { db: 'zcode-tui-sqlite', path: origin.path },
    ref: message.id,
    seq: message.seq,
    contentHash: hashContent(JSON.stringify(message.data)),
    hashOf: 'tui-message-data'
  }
}

export function journalEvidence(
  claim: string,
  origin: { path: string; profile: string },
  row: { sessionId: string; epoch: string; seq: number; rowJson: string }
): Evidence {
  return {
    claim,
    source: 'orca-journal',
    origin: { db: 'orca-journal', path: origin.path, profile: origin.profile },
    ref: `${row.sessionId}@${row.epoch}:${row.seq}`,
    seq: row.seq,
    contentHash: hashContent(row.rowJson),
    hashOf: 'journal-row-json'
  }
}

export type VerifyFailure = { claim: string; reason: string; detail?: string }

/**
 * S6 one-hop verifier: every quote must appear verbatim in the row its
 * evidence points at, and every contentHash must recompute. `lookup` fetches
 * the hashed object for an evidence ref from the live DB (read-only).
 */
export function verifyEvidence(
  quotes: { claim: string; quote: string; evidence: Evidence }[],
  lookup: (evidence: Evidence) => string | null
): VerifyFailure[] {
  const failures: VerifyFailure[] = []
  for (const { claim, quote, evidence } of quotes) {
    const hashed = lookup(evidence)
    if (hashed === null) {
      failures.push({ claim, reason: 'anchor-unresolvable', detail: evidence.ref })
      continue
    }
    if (hashContent(hashed) !== evidence.contentHash) {
      failures.push({ claim, reason: 'content-hash-mismatch', detail: evidence.ref })
      continue
    }
    const searchable = stripWhitespace(hashed)
    if (!searchable.includes(stripWhitespace(quote))) {
      failures.push({ claim, reason: 'quote-not-found', detail: quote.slice(0, 40) })
    }
  }
  return failures
}

function stripWhitespace(text: string): string {
  // Quotes are copied from rendered text; the hashed JSON escapes and wraps
  // differently, so compare on a whitespace-stripped projection.
  return text.replace(/\s+/g, '')
}
