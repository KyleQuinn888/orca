import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashContent, tuiEvidence, verifyEvidence } from './anchor'
import { parseCard, serializeCard, writeCard, type RoadmapCard } from './card'
import { refreshIndex } from './index-card'
import {
  buildDigest,
  isHumanUserMessage,
  proposeChapterWindows,
  readTuiSession,
  countUserRole
} from './tui-reader'
import { parseChapterJson } from './summarizer'

let fixtureDir: string
let fixtureDb: Database

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'roadmap-test-'))
  fixtureDb = new Database(join(fixtureDir, 'tui.db'))
  fixtureDb.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
     CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
     CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`
  )
  fixtureDb
    .query('INSERT INTO session VALUES (?,?,?,?,?)')
    .run('s1', '标题: 会话一', 'C:\\repo\\x', 1000, 9000)
  // 6 human messages, 3 injected, interleaved assistant turns
  const rows: [string, string, number, string, string[]][] = [
    ['m1', 'user', 0, 'user', ['开始任务A']],
    ['m2', 'assistant', 1, 'assistant', ['好的，执行A']],
    ['m3', 'user', 2, 'user', ['The TodoWrite tool hasn\u2019t been used recently.']],
    ['m4', 'assistant', 3, 'assistant', ['（长回复）'.repeat(100)]],
    ['m5', 'user', 4, 'user', ['<task-notification>', 'task done']],
    ['m6', 'user', 5, 'user', ['第二步：做B']],
    ['m7', 'assistant', 6, 'assistant', ['B 的结果']],
    ['m8', 'user', 7, 'user', ['第三步：验证C']],
    ['m9', 'assistant', 8, 'assistant', ['C 通过']],
    ['m10', 'user', 9, 'user', ['收尾：提交D']]
  ]
  for (const [id, role, seq, , texts] of rows) {
    const msgId = `msg_${id}`
    fixtureDb
      .query('INSERT INTO message VALUES (?,?,?,?,?,?)')
      .run(msgId, 's1', 1000 + seq * 100, 0, JSON.stringify({ role }), seq)
    for (const [i, text] of texts.entries()) {
      fixtureDb
        .query('INSERT INTO part VALUES (?,?,?,?,?,?,?)')
        .run(`p_${id}_${i}`, msgId, 's1', 0, 0, JSON.stringify({ type: 'text', text }), i)
    }
  }
})

afterAll(() => {
  fixtureDb.close()
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('S2 human-message detection', () => {
  it('flags TodoWrite reminders and task notifications as injections', () => {
    expect(isHumanUserMessage(['The TodoWrite tool hasn\u2019t been used recently.'])).toBe(false)
    expect(isHumanUserMessage(['<task-notification>', 'done'])).toBe(false)
    expect(isHumanUserMessage(['正常的人工输入'])).toBe(true)
  })
  it('reader counts 4 human of 6 user-role messages', () => {
    const session = readTuiSession(fixtureDb, 's1')
    expect(session.messages.filter((m) => m.role === 'user')).toHaveLength(6)
    expect(session.messages.filter((m) => m.human)).toHaveLength(4)
  })
})

describe('chapter windows + digest', () => {
  it('builds one window covering all human messages', () => {
    const session = readTuiSession(fixtureDb, 's1')
    const windows = proposeChapterWindows(session, { targetHuman: 20 })
    expect(windows).toHaveLength(1)
    expect(windows[0].userMsg.human).toBe(4)
    expect(windows[0].firstMsgSeq).toBe(0)
    expect(windows[0].lastMsgSeq).toBe(9)
  })
  it('digest keeps human messages whole, marks truncation honestly', () => {
    const session = readTuiSession(fixtureDb, 's1')
    const window = proposeChapterWindows(session, { targetHuman: 20 })[0]
    const full = buildDigest(session, window)
    expect(full.truncated).toBe(false)
    expect(full.digest).toContain('开始任务A')
    expect(full.digest).not.toContain('TodoWrite') // injections skipped
    const clipped = buildDigest(session, window, { maxChars: 60 })
    expect(clipped.truncated).toBe(true)
    expect(clipped.digest).toContain('未覆盖')
  })
  it('countUserRole totals 6 for the window', () => {
    const session = readTuiSession(fixtureDb, 's1')
    const window = proposeChapterWindows(session, { targetHuman: 20 })[0]
    expect(countUserRole(session, window)).toBe(6)
  })
})

describe('S4a hash + S6 one-hop verifier', () => {
  it('hashContent is stable and 16 hex chars', () => {
    expect(hashContent('{"a":1}')).toBe(hashContent('{"a":1}'))
    expect(hashContent('{"a":1}')).toMatch(/^[0-9a-f]{16}$/)
  })
  it('verifyEvidence passes a true quote and catches all three failure modes', () => {
    const data = { role: 'assistant', text: '模型整个窗口内从未进入软化，264.6 是截断不是真峰' }
    const evidence = tuiEvidence(
      '要点1',
      { path: '~/.zcode/cli/db/db.sqlite' },
      { id: 'msg_x', seq: 427, data }
    )
    const ok = verifyEvidence([{ claim: '要点1', quote: '264.6 是截断不是真峰', evidence }], () =>
      JSON.stringify(data)
    )
    expect(ok).toEqual([])
    const wrongQuote = verifyEvidence(
      [{ claim: '要点1', quote: '完全不存在的引文', evidence }],
      () => JSON.stringify(data)
    )
    expect(wrongQuote[0].reason).toBe('quote-not-found')
    const tamperedRow = verifyEvidence([{ claim: '要点1', quote: '264.6 是截断', evidence }], () =>
      JSON.stringify({ ...data, text: '被改写的行' })
    )
    expect(tamperedRow[0].reason).toBe('content-hash-mismatch')
    const missingRow = verifyEvidence([{ claim: '要点1', quote: 'x', evidence }], () => null)
    expect(missingRow[0].reason).toBe('anchor-unresolvable')
  })
})

describe('card round-trip + idempotent writes', () => {
  const card: RoadmapCard = {
    frontmatter: {
      v: 1,
      kind: 'session-chapter',
      source: 'zcode-tui-sqlite',
      session: 's1',
      workspace: 'C:\\repo\\x: 带冒号',
      title: '推进 B2: 载体裁决',
      chapter: { index: 1, slug: 'demo-chapter' },
      span: { firstMsgSeq: 0, lastMsgSeq: 9, userMsg: { human: 4, total: 6 } },
      time: {
        firstTime: '2026-10-04T01:19:13Z',
        lastTime: '2026-10-04T03:12:10Z',
        durationMin: 113,
        tz: 'UTC+8'
      },
      uncovered: '其余见 02-xxx.md',
      schemaNote: 'fixture',
      quality: 'agent-draft'
    },
    evidence: [
      tuiEvidence(
        '要点1',
        { path: '~/.zcode/cli/db/db.sqlite' },
        { id: 'msg_x', seq: 427, data: { role: 'user', text: '原文' } }
      )
    ],
    body: '# Ch.1 澄清裁决\n\n## 要点\n- **结论**。"原文引文"'
  }
  it('serialize -> parse round-trips every field', () => {
    const parsed = parseCard(serializeCard(card))
    expect(parsed.frontmatter.workspace).toBe(card.frontmatter.workspace)
    expect(parsed.frontmatter.title).toBe(card.frontmatter.title)
    expect(parsed.frontmatter.span.userMsg).toEqual({ human: 4, total: 6 })
    expect(parsed.frontmatter.time.durationMin).toBe(113)
    expect(parsed.evidence[0].ref).toBe('msg_x')
    expect(parsed.evidence[0].hashOf).toBe('tui-message-data')
    expect(parsed.body).toContain('# Ch.1')
  })
  it('writeCard is idempotent; handEdited keeps the original and drops a .new draft', () => {
    const dir = join(fixtureDir, 'cards')
    const first = writeCard(dir, card)
    expect(first.outcome).toBe('written')
    const again = writeCard(dir, card)
    expect(again.outcome).toBe('written') // same content, clean overwrite of a non-hand-edited card
    const edited = parseCard(readFileSync(first.path, 'utf8'))
    edited.frontmatter.handEdited = true
    writeFileSync(first.path, serializeCard(edited), 'utf8')
    const third = writeCard(dir, card)
    expect(third.outcome).toBe('hand-edited-kept')
    expect(existsSync(third.draftPath)).toBe(true)
    expect(parseCard(readFileSync(third.path, 'utf8')).frontmatter.handEdited).toBe(true)
  })
})

describe('S1 index card', () => {
  it('refreshIndex scans chapter cards from disk and writes 00-index.md', () => {
    const dir = join(fixtureDir, 'indexed')
    mkdirSync(join(dir, 'chapters'), { recursive: true })
    const chapter: RoadmapCard = {
      ...cardFixture(),
      frontmatter: { ...cardFixture().frontmatter, chapter: { index: 1, slug: 'one' } }
    }
    const written = writeCard(join(dir, 'chapters'), chapter)
    expect(written.outcome).toBe('written')
    refreshIndex(join(dir, 'chapters'), {
      source: 'zcode-tui-sqlite',
      session: 's1',
      workspace: 'C:\\repo\\x',
      title: '会话一',
      chapters: [],
      sessionUncovered: '共 1 章'
    })
    const indexText = readFileSync(join(dir, 'chapters', '00-index.md'), 'utf8')
    expect(indexText).toContain('| 1 |')
    expect(indexText).toContain('澄清裁决')
  })
})

describe('summarizer reply parsing', () => {
  it('extracts the last JSON object from noisy output', () => {
    const noisy =
      '前置说明\n{"title":"T","points":["p1"],"decisions":[],"artifacts":[],"pitfalls":[]}\n后置'
    const parsed = parseChapterJson(noisy)
    expect(parsed?.title).toBe('T')
    expect(parseChapterJson('no json here')).toBeNull()
  })
})

function cardFixture(): RoadmapCard {
  return {
    frontmatter: {
      v: 1,
      kind: 'session-chapter',
      source: 'zcode-tui-sqlite',
      session: 's1',
      workspace: 'C:\\repo\\x',
      title: '推进 B2',
      chapter: { index: 1, slug: 'one' },
      span: { firstMsgSeq: 0, lastMsgSeq: 9, userMsg: { human: 4, total: 6 } },
      time: {
        firstTime: '2026-10-04T01:19:13Z',
        lastTime: '2026-10-04T03:12:10Z',
        durationMin: 113
      },
      uncovered: 'test',
      quality: 'agent-draft'
    },
    evidence: [],
    body: '# Ch.1 澄清裁决\n\n## 要点\n- x'
  }
}
