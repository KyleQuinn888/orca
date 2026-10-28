import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import Database from '../sqlite/sync-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from '../native-chat/agent-session-journal/journal-database-schema'
import { scopeFor, scopeForGeneration } from './session-id-bridge'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const NATIVE = 'sess-native-1'
const WS = 'ws-1::C:/ws/alpha'
const J_LIVE = 'zcode_live'
const J_OLD = 'zcode_old'
const J_STRAY = 'zcode_stray' // rows mention the native id, no record

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-id-bridge-'))
  dirs.push(dir)
  const db = new Database(join(dir, 'agent-session-journal.db'))
  db.exec(`${createJournalTablesSql()} ${createAgentSessionRecordTablesSql()}`)
  const chainOf = (nativeIds: string[]) =>
    JSON.stringify({
      providerHandleChain: nativeIds.map((nativeId, index) => ({
        linkId: `link-${index}`,
        handle: { transport: 'zcode-app-server', agent: 'zcode', nativeId },
        origin: index === 0 ? 'created' : 'resumed',
        mintedAtFence: index,
        observedAt: index
      }))
    })
  const ins = db.prepare('INSERT INTO agent_session_records VALUES (?, ?)')
  ins.run(J_OLD, chainOf([NATIVE]))
  ins.run(J_LIVE, chainOf([NATIVE]))
  const insS = db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)')
  insS.run(J_LIVE, WS, 'e1')
  insS.run(J_OLD, WS, 'e1')
  insS.run(J_STRAY, 'ws-2::C:/ws/beta', 'e1')
  // a stray ROW whose payload mentions the native id
  db.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(
    J_STRAY,
    'e1',
    1,
    1,
    JSON.stringify({ sessionId: J_STRAY, body: { native: NATIVE } })
  )
  db.close()
  return dir
}

describe('session-id-bridge', () => {
  it('native id resolves to journal carriers with the live head first', () => {
    const dir = seed()
    const scope = scopeFor(dir, NATIVE, null)
    expect(scope.nativeId).toBe(NATIVE)
    expect(scope.journalIds[0]).toBe(J_LIVE)
    expect(scope.journalIds).toContain(J_OLD)
    expect(scope.workspacePath).toBe('C:/ws/alpha')
  })

  it('journal id reverse-resolves to the native scope', () => {
    const dir = seed()
    const scope = scopeFor(dir, J_LIVE, 'fallback-ws')
    expect(scope.nativeId).toBe(NATIVE)
    expect(scope.journalIds[0]).toBe(J_LIVE)
    expect(scope.workspacePath).toBe('C:/ws/alpha')
  })

  it('generation scope filters exhaustive hits by workspace (transcript mentions excluded)', () => {
    const dir = seed()
    const scope = scopeForGeneration(dir, NATIVE, null)
    expect(scope.journalIds).not.toContain(J_STRAY)
    expect(scope.nativeId).toBe(NATIVE)
  })

  it('unknown id passes through as its own carrier with the fallback workspace', () => {
    const dir = seed()
    const scope = scopeFor(dir, 'sess-unknown', 'fallback-ws')
    expect(scope.nativeId).toBe('sess-unknown')
    expect(scope.journalIds).toEqual(['sess-unknown'])
    expect(scope.workspacePath).toBe('fallback-ws')
  })
})
