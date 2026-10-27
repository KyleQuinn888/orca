// Evidence anchors for roadmap cards (schema v1.1, re-reviewed 2026-10-25).
// An anchor points at one durable row in a source DB so a card claim stays
// one hop verifiable; contentHash pins the row's RAW bytes so schema drift
// is detectable. hashOf is required on every entry (no silent defaults).

import { createHash } from 'node:crypto'

export type AnchorSource = 'tui-sqlite' | 'orca-journal'

export type AnchorOrigin =
  | { db: 'tui-sqlite'; path: string }
  | { db: 'orca-journal'; path: string; profile: string }

export type Evidence = {
  claim: string
  source: AnchorSource
  origin: AnchorOrigin
  /** TUI: message row id. Journal: journal row identity (sessionId@epoch:seq). */
  ref: string
  seq: number
  /** Verbatim quote from the source row; the mechanical object of S6 inclusion checks. */
  quote?: string
  /** sha256 over the hashed object's RAW SQLite column bytes, first 16 hex chars. */
  contentHash: string
  /** S4a: names what contentHash covers so a schema migration can recompute. */
  hashOf: 'tui-message-data' | 'journal-row-json'
}

/** sha256 over the payload's UTF-8 bytes, first 16 hex chars, lowercase. */
export function hashContent(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16)
}

export function tuiEvidence(
  claim: string,
  origin: { path: string },
  message: { id: string; seq: number; rawData: string },
  quote?: string
): Evidence {
  return {
    claim,
    source: 'tui-sqlite',
    origin: { db: 'tui-sqlite', path: origin.path },
    ref: message.id,
    seq: message.seq,
    quote,
    // RAW bytes of the SQLite data column — never a re-serialization (review
    // P0-3: JSON.stringify key order is not a contract).
    contentHash: hashContent(message.rawData),
    hashOf: 'tui-message-data'
  }
}

export function journalEvidence(
  claim: string,
  origin: { path: string; profile: string },
  row: { sessionId: string; epoch: string; seq: number; rowJson: string },
  quote?: string
): Evidence {
  return {
    claim,
    source: 'orca-journal',
    origin: { db: 'orca-journal', path: origin.path, profile: origin.profile },
    ref: `${row.sessionId}@${row.epoch}:${row.seq}`,
    seq: row.seq,
    quote,
    contentHash: hashContent(row.rowJson),
    hashOf: 'journal-row-json'
  }
}

export type VerifyFailure = { claim: string; reason: string; detail?: string }

export type QuoteCheck = { claim: string; quote: string; evidence: Evidence }

export type VerifySurfaces = {
  /** Exactly what hashOf covers (the anchored row's RAW bytes). */
  hashPayload: string | null
  /** Where the quote may verbatim-appear (anchored row + its child rows). */
  searchText: string | null
}

/**
 * S6 one-hop verifier: contentHash must recompute over the anchored row's
 * RAW bytes (hashPayload), and evidence.quote must appear verbatim in the
 * message's full stored text (searchText covers part rows where the
 * conversational text lives). Two surfaces, never conflated.
 */
export function verifyEvidence(
  checks: QuoteCheck[],
  lookup: (evidence: Evidence) => VerifySurfaces
): VerifyFailure[] {
  const failures: VerifyFailure[] = []
  for (const { claim, quote, evidence } of checks) {
    const surfaces = lookup(evidence)
    if (surfaces.hashPayload === null || surfaces.searchText === null) {
      failures.push({ claim, reason: 'anchor-unresolvable', detail: evidence.ref })
      continue
    }
    if (hashContent(surfaces.hashPayload) !== evidence.contentHash) {
      failures.push({ claim, reason: 'content-hash-mismatch', detail: evidence.ref })
      continue
    }
    if (!stripWhitespace(surfaces.searchText).includes(stripWhitespace(quote))) {
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
