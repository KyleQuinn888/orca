import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import Database from '../sqlite/sync-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from '../native-chat/agent-session-journal/journal-database-schema'
import { resolveJournalSessionsByNativeId } from './journal-session-resolve'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function seed(
  name: string,
  records: Array<{ sessionId: string; nativeIds: string[] }>,
  sessions: Array<{ sessionId: string; workspaceId: string }>
): string {
  // The resolver joins the journal file name onto its dir, so each case seeds
  // its own dir with the canonical file name.
  const dir = mkdtempSync(join(tmpdir(), `journal-session-resolve-${name}-`))
  dirs.push(dir)
  const db = new Database(join(dir, 'agent-session-journal.db'))
  db.exec(`${createJournalTablesSql()} ${createAgentSessionRecordTablesSql()}`)
  const insertRecord = db.prepare('INSERT INTO agent_session_records VALUES (?, ?)')
  for (const record of records) {
    // Production chains are created plus resumed links; the last native id is
    // the chain head (the live continuation). A chain naming a SECOND native id
    // reaches it by fork: resumes may only extend the same root.
    const handleOf = (nativeId: string) => ({
      transport: 'zcode-app-server',
      agent: 'zcode',
      nativeId
    })
    const chain = record.nativeIds.map((nativeId, index) => ({
      linkId: `link-${index}`,
      handle: handleOf(nativeId),
      origin:
        index === 0 ? 'created' : index === record.nativeIds.length - 1 ? 'forked' : 'resumed',
      ...(index === record.nativeIds.length - 1 && index > 0
        ? {
            forkedFromKey: `zcode-app-server/zcode:${JSON.stringify(record.nativeIds[0] as string)}`
          }
        : {}),
      mintedAtFence: index,
      observedAt: index
    }))
    insertRecord.run(record.sessionId, JSON.stringify({ providerHandleChain: chain }))
  }
  const insertSession = db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)')
  for (const session of sessions) {
    insertSession.run(session.sessionId, session.workspaceId, 'e1')
  }
  db.close()
  return dir
}

describe('resolveJournalSessionsByNativeId', () => {
  it('resolves a native id to the journal session whose record carries it', () => {
    const dbPath = seed('simple',
      [{ sessionId: 'zcode_live', nativeIds: ['sess_a'] }],
      [{ sessionId: 'zcode_live', workspaceId: 'ws-1::C:/work/one' }]
    )
    expect(resolveJournalSessionsByNativeId(dbPath, 'sess_a')).toEqual({
      journalSessionId: 'zcode_live',
      journalSessionIds: ['zcode_live'],
      workspacePath: 'C:/work/one'
    })
  })

  it('prefers the record whose chain HEAD carries the native id over superseded tails', () => {
    const dbPath = seed('heads',
      [
        // The old session seeded the conversation, then resumed past it: its
        // chain head names a later native id, so sess_a is a tail link there.
        { sessionId: 'zcode_old', nativeIds: ['sess_a', 'sess_b'] },
        // The live session resumed the same conversation; its head is sess_a.
        { sessionId: 'zcode_live', nativeIds: ['sess_a'] }
      ],
      [
        { sessionId: 'zcode_old', workspaceId: 'ws-1::C:/work/old' },
        { sessionId: 'zcode_live', workspaceId: 'ws-1::C:/work/one' }
      ]
    )
    expect(resolveJournalSessionsByNativeId(dbPath, 'sess_a')).toEqual({
      journalSessionId: 'zcode_live',
      journalSessionIds: ['zcode_live', 'zcode_old'],
      workspacePath: 'C:/work/one'
    })
  })

  it('returns null for an unknown id or a missing database, never a partial row', () => {
    const dbPath = seed('simple',
      [{ sessionId: 'zcode_live', nativeIds: ['sess_a'] }],
      [{ sessionId: 'zcode_live', workspaceId: 'ws-1::C:/work/one' }]
    )
    expect(resolveJournalSessionsByNativeId(dbPath, 'sess_unknown')).toBeNull()
    expect(resolveJournalSessionsByNativeId(join(dbPath, 'missing'), 'sess_a')).toBeNull()
    expect(resolveJournalSessionsByNativeId(dbPath, '')).toBeNull()
  })
})
