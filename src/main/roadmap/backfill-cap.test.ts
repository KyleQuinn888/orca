// D3: 8s hard-cap assertion (owner ruling: accept a few seconds of block, not
// longer): worst-case backfill synchronous TAIL (final cross-chunk dedup +
// sort + countExistingChapters + segmentRows) must stay under 8s.
//
// The tail is everything AFTER the last setImmediate yield: the final
// cross-chunk dedup pass, the sort, the chapter count, the segmentation. The
// reads and the chunked dedup are yielded and NOT part of the cap.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dedupRowsAcrossCarriers } from './row-dedup'
import { DEFAULT_SEGMENTATION_CONFIG, segmentRows, type JournalRowRef } from './journal-reader'
import { countExistingChapters } from './journal-row-io'

const HARD_CAP_MS = 8000

function makeRows(count: number): JournalRowRef[] {
  const rows: JournalRowRef[] = []
  const epoch = 'e-cap-0001'
  for (let i = 0; i < count; i++) {
    rows.push({
      sessionId: 'zcode_cap_carrier_a',
      epoch,
      seq: i + 1,
      ts: 1_000_000_000 + i * 60000,
      rowJson: JSON.stringify({
        kind: 'item',
        itemId: `legacy:zcode:zcode_cap_carrier_a:item%3Ap%3Asess_cap%3Amsg_${i}`,
        revision: 1,
        body: {
          kind: 'message',
          role: i % 3 === 0 ? 'user' : 'assistant',
          content: `cap stress message ${i} with realistic content to give the parser and the segmentation something to chew on`
        }
      })
    })
    // turn boundary every 5 rows gives segmentation boundaries
    if (i % 5 === 4) {
      rows.push({
        sessionId: 'zcode_cap_carrier_a',
        epoch,
        seq: i + 1 + 100000,
        ts: 1_000_000_000 + i * 60000 + 1,
        rowJson: JSON.stringify({
          kind: 'lifecycle-batch',
          itemId: `legacy:zcode:zcode_cap_carrier_a:turn%3Ap%3Asess_cap%3Aturn_${i}`,
          revision: 1,
          body: {}
        })
      })
    }
  }
  return rows
}

describe('D3: backfill synchronous tail hard cap (8s)', () => {
  it('worst-case tail (final dedup + sort + count + segment) stays under 8s', () => {
    // 30k raw rows (dedup to ~18k) is beyond any realistic single conversation
    const raw = makeRows(30000)
    const t0 = Date.now()
    const deduped = dedupRowsAcrossCarriers(raw)
    const sorted = [...deduped].sort(
      (a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.epoch.localeCompare(b.epoch) || a.seq - b.seq
    )
    const ws = mkdtempSync(join(tmpdir(), 'cap-ws-'))
    const countedAt = countExistingChapters(ws, 'sess_cap')
    const { cuts } = segmentRows(
      'sess_cap',
      sorted,
      null,
      DEFAULT_SEGMENTATION_CONFIG,
      countedAt + 1
    )
    const tailMs = Date.now() - t0
    rmSync(ws, { recursive: true, force: true })
    // the assertion: the tail must stay under the cap AND the run must have
    // actually produced cuts (a cap check over a no-op proves nothing)
    expect(cuts.length).toBeGreaterThan(0)
    expect(tailMs).toBeLessThanOrEqual(HARD_CAP_MS)
  })
})
