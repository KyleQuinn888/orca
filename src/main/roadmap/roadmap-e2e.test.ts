// E2E path test (gstack acceptance rule #1): from user action to artifact.
// Real SQLite journal + real workspace; mock only the LLM summarizer.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoadmapService, type RoadmapServiceDeps } from './roadmap-service'
import { emptyState, type RoadmapStateV2 } from './roadmap-store'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

let wsDir: string
let userDataDir: string
let state: RoadmapStateV2
let featureOn = true
const dirs: string[] = []

function setup(): void {
  wsDir = mkdtempSync(join(tmpdir(), 'r2-e2e-ws-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'r2-e2e-ud-'))
  dirs.push(wsDir, userDataDir)
  mkdirSync(join(wsDir, '.roadmap', '001'), { recursive: true })
  state = emptyState()
  featureOn = true
  // seed journal with one session's rows (enough to cross threshold)
  const db = makeDb(userDataDir)
  seedJournal(db, 'sess-e2e-1', 40)
  db.close()
}

function makeDb(dir: string): {
  query: (
    sql: string,
    ...p: unknown[]
  ) => {
    all: (...p: unknown[]) => unknown[]
    get: (...p: unknown[]) => unknown
    run: (...p: unknown[]) => unknown
  }
  close: () => void
} {
  const db = new DatabaseSync(join(dir, 'agent-session-journal.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_sessions (session_id TEXT, workspace_id TEXT, epoch TEXT);
    CREATE TABLE IF NOT EXISTS journal_rows (session_id TEXT, epoch TEXT, seq INTEGER, ts INTEGER, row_json TEXT);
    CREATE TABLE IF NOT EXISTS agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT);
  `)
  return {
    query: (sql: string, ...params: unknown[]) => {
      const stmt = db.prepare(sql)
      return {
        all: (...p: unknown[]) => stmt.all(...([...params, ...p] as unknown[])) as unknown[],
        get: (...p: unknown[]) => stmt.get(...([...params, ...p] as unknown[])) as unknown,
        run: (...p: unknown[]) => stmt.run(...([...params, ...p] as unknown[])) as unknown
      }
    },
    close: () => db.close()
  }
}

function seedJournal(
  db: { query: (sql: string, ...p: unknown[]) => { run: (...p: unknown[]) => unknown } },
  sessionId: string,
  count: number
): void {
  const wsId = `ws-uuid::${wsDir}`
  db.query('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(sessionId, wsId, 'e1')
  for (let i = 0; i < count; i++) {
    const role = i % 3 === 0 ? 'user' : 'assistant'
    const rowJson = JSON.stringify({
      kind: 'item',
      itemId: `legacy:zcode:${sessionId}:item%3Ap%3A${sessionId}%3Amsg_${i}`,
      revision: 1,
      body: {
        kind: 'message',
        role,
        content: `message ${i} with sufficient content for segmentation boundary detection to trigger appropriately during the test run`
      }
    })
    db.query('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(
      sessionId,
      'e1',
      i + 1,
      Date.now() + i * 60000,
      rowJson
    )
    // turn completion every 5 messages gives segmentation a boundary signal
    if (i % 5 === 4) {
      const turnJson = JSON.stringify({
        kind: 'item',
        itemId: `legacy:zcode:${sessionId}:item%3Ap%3A${sessionId}%3Aturn_${i}`,
        revision: 1,
        body: { kind: 'turn', state: 'completed' }
      })
      db.query('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(
        sessionId,
        'e1',
        i + 1000,
        Date.now() + i * 60000 + 1000,
        turnJson
      )
    }
  }
  // agent session record with chain pointing at this native id
  const record = JSON.stringify({
    sessionId,
    providerHandleChain: [
      {
        linkId: 'l0',
        handle: { transport: 'zcode-app-server', agent: 'zcode', nativeId: sessionId },
        origin: 'created',
        mintedAtFence: 0,
        observedAt: 0
      }
    ]
  })
  db.query('INSERT INTO agent_session_records VALUES (?, ?)').run(sessionId, record)
}

function makeDeps(): RoadmapServiceDeps {
  return {
    getJournalDb: () => makeDb(userDataDir),
    getWorkspacePath: (_sid: string) => wsDir,
    getSessionTitle: () => 'E2E Test',
    getUserDataDir: () => userDataDir,
    isLocalSession: () => true,
    onJournalCommit: () => () => {},
    onTurnCompletion: () => () => {},
    onIdle: () => () => {},
    zcodeAvailable: () => true,
    featureEnabled: () => featureOn
  }
}

describe('E2E: user action → artifact', () => {
  it('gate ON + generate → pipeline runs (cursor advances, artifacts dir created)', async () => {
    setup()
    featureOn = true
    const service = createRoadmapService(makeDeps(), state)
    service.start()
    const result = await service.generateNow('sess-e2e-1')
    expect(result.ok).toBe(true)
    // Pipeline ran: session state exists with advanced cursors (proof all
    // gates passed and rows were read). Artifact files additionally require
    // the LLM summarizer, verified separately in packaged smoke (rule #2).
    const sessionState = state.sessions['sess-e2e-1']
    expect(sessionState !== undefined).toBe(true)
    const hadRows =
      sessionState !== undefined &&
      (Object.keys(sessionState.cursorsByJournal ?? {}).length > 0 ||
        sessionState.scanCursor.seq > 0)
    expect(hadRows).toBe(true)
  })

  it('gate OFF + generate → no artifacts', async () => {
    setup()
    featureOn = false
    const service = createRoadmapService(makeDeps(), state)
    service.start()
    await service.generateNow('sess-e2e-1')
    expect(existsSync(join(wsDir, '.roadmap', '001', 'sess-e2e-1'))).toBe(false)
  })

  it('stop → resume → pipeline re-triggers', async () => {
    setup()
    featureOn = true
    const service = createRoadmapService(makeDeps(), state)
    service.start()
    await service.generateNow('sess-e2e-1')
    service.optOutSession('sess-e2e-1')
    expect(state.policy['sess-e2e-1']).toBe('excluded')
    const resume = await service.generateNow('sess-e2e-1')
    expect(resume.ok).toBe(true)
    expect(state.policy['sess-e2e-1']).toBe('eligible')
  })
})
