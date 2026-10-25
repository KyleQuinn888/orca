import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashContent, tuiEvidence, verifyEvidence } from './anchor'
import { CardParseError, parseCard, serializeCard, writeCard, type RoadmapCard } from './card'
import { refreshIndex } from './index-card'
import {
  buildDigest,
  isHumanUserMessage,
  proposeChapterWindows,
  readTuiSession,
  countUserRole
} from './tui-reader'
import { parseChapterJson } from './summarizer'
import { rebuildPitsIndex } from './pits-index'

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
  const rows: [string, string, number, string, string[], string[]][] = [
    ['m1', 'user', 0, 'user', ['开始任务A'], []],
    ['m2', 'assistant', 1, 'assistant', ['好的，执行A'], ['Read', 'Edit']],
    ['m3', 'user', 2, 'user', ['The TodoWrite tool hasn\u2019t been used recently.'], []],
    ['m4', 'assistant', 3, 'assistant', ['（长回复）'.repeat(100)], []],
    ['m5', 'user', 4, 'user', ['<task-notification>', 'task done'], []],
    ['m6', 'user', 5, 'user', ['第二步：做B'], []],
    ['m7', 'assistant', 6, 'assistant', ['B 的结果'], ['Bash']],
    ['m8', 'user', 7, 'user', ['第三步：验证C'], []],
    ['m9', 'assistant', 8, 'assistant', ['C 通过'], []],
    ['m10', 'user', 9, 'user', ['收尾：提交D'], []]
  ]
  for (const [id, role, seq, , texts, tools] of rows) {
    const msgId = `msg_${id}`
    const rawData = JSON.stringify({ role, model: 'test', tokens: seq * 10 })
    fixtureDb
      .query('INSERT INTO message VALUES (?,?,?,?,?,?)')
      .run(msgId, 's1', 1000 + seq * 100, 0, rawData, seq)
    for (const [i, text] of texts.entries()) {
      fixtureDb
        .query('INSERT INTO part VALUES (?,?,?,?,?,?,?)')
        .run(`p_${id}_${i}`, msgId, 's1', 0, 0, JSON.stringify({ type: 'text', text }), i)
    }
    for (const [i, tool] of tools.entries()) {
      fixtureDb
        .query('INSERT INTO part VALUES (?,?,?,?,?,?,?)')
        .run(
          `pt_${id}_${i}`,
          msgId,
          's1',
          0,
          0,
          JSON.stringify({ type: 'tool', tool }),
          texts.length + i
        )
    }
  }
})

afterAll(() => {
  fixtureDb.close()
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('S2 human-message detection', () => {
  it('flags injections and counts 4 human of 6 user-role rows', () => {
    expect(isHumanUserMessage(['The TodoWrite tool hasn\u2019t been used recently.'])).toBe(false)
    expect(isHumanUserMessage(['正常的人工输入'])).toBe(true)
    const session = readTuiSession(fixtureDb, 's1')
    expect(session.messages.filter((m) => m.role === 'user')).toHaveLength(6)
    expect(session.messages.filter((m) => m.human)).toHaveLength(4)
    expect(session.messages.find((m) => m.seq === 1)?.tools).toEqual(['Read', 'Edit'])
    expect(session.messages.at(0)?.rawData).toContain('"role":"user"')
  })
})

describe('v1.1 chapter windows: gap closure + tail merge', () => {
  it('closes inter-chapter gaps (lastMsgSeq = next first - 1)', () => {
    const session = readTuiSession(fixtureDb, 's1')
    const windows = proposeChapterWindows(session, { targetHuman: 2 })
    // human rows at seq [0, 5, 7, 9]; ch1 = human 0..1, covers through seq 6
    // (next chapter's first human message 7 minus 1); ch2 = human 2..3 + tail.
    expect(windows.length).toBe(2)
    expect(windows[0].firstMsgSeq).toBe(0)
    expect(windows[0].lastMsgSeq).toBe(6)
    expect(windows[1].firstMsgSeq).toBe(7)
    expect(windows[1].lastMsgSeq).toBe(9)
  })
  it('merges a tail below half bandwidth into the previous chapter', () => {
    const session = readTuiSession(fixtureDb, 's1')
    const windows = proposeChapterWindows(session, { targetHuman: 3 })
    expect(windows).toHaveLength(1)
    expect(windows[0].userMsg.human).toBe(4)
    expect(windows[0].lastMsgSeq).toBe(9)
  })
  it('countUserRole totals 6 for a full-session window', () => {
    const session = readTuiSession(fixtureDb, 's1')
    const window = proposeChapterWindows(session, { targetHuman: 20 })[0]
    expect(countUserRole(session, window)).toBe(6)
  })
})

describe('digest', () => {
  it('keeps human messages whole, carries tool lines, marks truncation', () => {
    const session = readTuiSession(fixtureDb, 's1')
    const window = proposeChapterWindows(session, { targetHuman: 20 })[0]
    const full = buildDigest(session, window)
    expect(full.truncated).toBe(false)
    expect(full.digest).toContain('开始任务A')
    expect(full.digest).not.toContain('TodoWrite')
    expect(full.digest).toContain('工具：Read、Edit')
    const clipped = buildDigest(session, window, { maxChars: 60 })
    expect(clipped.truncated).toBe(true)
    expect(clipped.digest).toContain('未覆盖')
  })
})

describe('S4a raw-byte hash + S6 verifier', () => {
  it('hashes raw data-column bytes, not re-serialized JSON', () => {
    const raw = '{"role":"assistant","text":"264.6 是截断不是真峰"}'
    const evidence = tuiEvidence(
      '要点1',
      { path: '~/.zcode/db.sqlite' },
      { id: 'msg_x', seq: 427, rawData: raw },
      '264.6 是截断不是真峰'
    )
    expect(evidence.contentHash).toBe(hashContent(raw))
    expect(evidence.quote).toBe('264.6 是截断不是真峰')
  })
  it('verifies true quotes and catches all three failure modes', () => {
    const raw = '{"role":"user","text":"模型整个窗口内从未进入软化"}'
    const surfaces = { hashPayload: raw, searchText: raw }
    const evidence = tuiEvidence(
      '要点1',
      { path: 'p' },
      { id: 'm', seq: 1, rawData: raw },
      '从未进入软化'
    )
    expect(
      verifyEvidence([{ claim: '要点1', quote: '从未进入软化', evidence }], () => surfaces)
    ).toEqual([])
    expect(
      verifyEvidence([{ claim: '要点1', quote: '完全不存在的引文', evidence }], () => surfaces)[0]
        .reason
    ).toBe('quote-not-found')
    expect(
      verifyEvidence([{ claim: '要点1', quote: '软化', evidence }], () => ({
        hashPayload: '{"tampered":1}',
        searchText: '{"tampered":1}'
      }))[0].reason
    ).toBe('content-hash-mismatch')
    expect(
      verifyEvidence([{ claim: '要点1', quote: 'x', evidence }], () => ({
        hashPayload: null,
        searchText: null
      }))[0].reason
    ).toBe('anchor-unresolvable')
    // conversational text lives in part rows: search surface wider than hash
    const partText = '{"type":"text","text":"引文在 part 行里"}'
    const partEvidence = tuiEvidence(
      '要点2',
      { path: 'p' },
      { id: 'm2', seq: 2, rawData: raw },
      '引文在 part 行里'
    )
    expect(
      verifyEvidence(
        [{ claim: '要点2', quote: '引文在 part 行里', evidence: partEvidence }],
        () => ({ hashPayload: raw, searchText: `${raw}\n${partText}` })
      )
    ).toEqual([])
  })
})

describe('card v1.1 round-trip', () => {
  const card: RoadmapCard = {
    frontmatter: {
      v: 1,
      kind: 'session-chapter',
      source: 'tui-sqlite',
      session: 's1',
      workspace: 'C:\\repo\\x: 带冒号 #和哈希',
      title: '推进 B2: 载体裁决',
      chapter: { index: 12, slug: 'demo-chapter' },
      span: { firstMsgSeq: 0, lastMsgSeq: 9, userMsg: { human: 4, total: 6 } },
      time: {
        firstTime: '2026-10-04T01:19:13Z',
        lastTime: '2026-10-04T03:12:10Z',
        durationMin: 113,
        tzOffsetMin: 480,
        tzNote: 'UTC+8'
      },
      uncovered: [
        { fromSeq: 10, toSeq: 380, note: '未生成章节' },
        { fromSeq: 501, toSeq: 3231 }
      ],
      quality: 'draft',
      provenance: 'llm',
      digestTruncated: true,
      schemaNote: 'fixture',
      extra: { 'x-experiment': 'keep-me' }
    },
    anchors: {
      source: 'tui-sqlite',
      origin: { db: 'tui-sqlite', path: '~/.zcode/cli/db/db.sqlite' }
    },
    evidence: [
      tuiEvidence(
        '要点1',
        { path: '~/.zcode/cli/db/db.sqlite' },
        { id: 'msg_x', seq: 427, rawData: '{"role":"user"}' },
        '引文内容够长'
      )
    ],
    body: '# Ch.12 澄清裁决\n\n## 要点\n- **结论**。"引文内容够长"'
  }
  it('round-trips every field including extra and structured uncovered', () => {
    const parsed = parseCard(serializeCard(card))
    expect(parsed.frontmatter.workspace).toBe(card.frontmatter.workspace)
    expect(parsed.frontmatter.chapter?.index).toBe(12)
    expect(parsed.frontmatter.uncovered).toEqual(card.frontmatter.uncovered)
    expect(parsed.frontmatter.provenance).toBe('llm')
    expect(parsed.frontmatter.digestTruncated).toBe(true)
    expect(parsed.frontmatter.extra['x-experiment']).toBe('keep-me')
    expect(parsed.anchors?.origin.path).toContain('db.sqlite')
    expect(parsed.evidence[0].quote).toBe('引文内容够长')
    expect(parsed.evidence[0].hashOf).toBe('tui-message-data')
  })
  it('tolerates CRLF hand edits and inline comments', () => {
    const crlf = serializeCard(card)
      .replace(/\n/g, '\r\n')
      .replace('quality: draft', 'quality: draft  # 手改')
    const parsed = parseCard(crlf)
    expect(parsed.frontmatter.quality).toBe('draft')
  })
  it('rejects v:2 and missing hashOf instead of failing open', () => {
    const v2 = serializeCard(card).replace('v: 1', 'v: 2')
    expect(() => parseCard(v2)).toThrow(CardParseError)
    const noHashOf = serializeCard(card).replace('    hashOf: tui-message-data\n', '')
    expect(() => parseCard(noHashOf)).toThrow(/hashOf/)
  })
})

describe('writeCard v1.1 lifecycle', () => {
  it('supersedes same-index stale slugs instead of orphaning them', () => {
    const dir = join(fixtureDir, 'cards-a')
    const first = writeCard(dir, chapterCard(1, 'old-slug'))
    expect(first.outcome).toBe('written')
    expect(existsSync(first.path)).toBe(true)
    const second = writeCard(dir, chapterCard(1, 'new-slug'))
    expect(second.outcome).toBe('written')
    expect(existsSync(join(dir, '001-old-slug.superseded.md'))).toBe(true)
    expect(existsSync(join(dir, '001-new-slug.md'))).toBe(true)
  })
  it('quarantines unparseable cards to .legacy.md instead of aborting', () => {
    const dir = join(fixtureDir, 'cards-b')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '001-junk.md'), 'not a card at all', 'utf8')
    const result = writeCard(dir, chapterCard(1, 'clean'))
    expect(result.outcome).toBe('legacy-quarantined')
    expect(existsSync(join(dir, '001-junk.legacy.md'))).toBe(true)
    expect(existsSync(join(dir, '001-clean.md'))).toBe(true)
  })
  it('keeps handEdited originals (CRLF included) and writes .new.md drafts', () => {
    const dir = join(fixtureDir, 'cards-c')
    const first = writeCard(dir, chapterCard(1, 'protected'))
    const edited = parseCard(readFileSync(first.path, 'utf8'))
    edited.frontmatter.handEdited = true
    writeFileSync(first.path, serializeCard(edited).replace(/\n/g, '\r\n'), 'utf8')
    const again = writeCard(dir, chapterCard(1, 'protected'))
    expect(again.outcome).toBe('hand-edited-kept')
    expect(existsSync(again.draftPath)).toBe(true)
    expect(parseCard(readFileSync(again.path, 'utf8')).frontmatter.handEdited).toBe(true)
  })
})

describe('S1 index card (session-index kind)', () => {
  it('emits kind session-index with slug column and escapes pipes', () => {
    const dir = join(fixtureDir, 'indexed')
    mkdirSync(dir, { recursive: true })
    const chapter = chapterCard(1, 'one')
    chapter.body = '# Ch.1 标题带|竖线\n\n## 要点\n- x'
    writeCard(dir, chapter)
    refreshIndex(dir, {
      source: 'tui-sqlite',
      session: 's1',
      workspace: 'C:\\repo\\x',
      title: '会话一',
      chapters: [],
      sessionUncoveredNote: '共 1 章',
      tzOffsetMin: 480
    })
    const indexText = readFileSync(join(dir, '000-index.md'), 'utf8')
    expect(indexText).toContain('kind: session-index')
    expect(indexText).not.toContain('kind: session-chapter')
    expect(indexText).toContain('| one |')
    expect(indexText).toContain(String.raw`\|`)
  })
})

describe('summarizer reply parsing', () => {
  it('normalizes string and {text,seq} point forms', () => {
    const noisy =
      '说明\n{"title":"T","points":[{"text":"p1","seq":11}],"decisions":["纯字符串"],"artifacts":[],"pitfalls":[]}'
    const parsed = parseChapterJson(noisy)
    expect(parsed?.points[0]).toEqual({ text: 'p1', seq: 11 })
    expect(parsed?.decisions[0]).toEqual({ text: '纯字符串' })
    expect(parseChapterJson('no json')).toBeNull()
  })
})

function chapterCard(index: number, slug: string): RoadmapCard {
  return {
    frontmatter: {
      v: 1,
      kind: 'session-chapter',
      source: 'tui-sqlite',
      session: 's1',
      workspace: 'C:\\repo\\x',
      title: '推进 B2',
      chapter: { index, slug },
      span: { firstMsgSeq: 0, lastMsgSeq: 9, userMsg: { human: 4, total: 6 } },
      time: {
        firstTime: '2026-10-04T01:19:13Z',
        lastTime: '2026-10-04T03:12:10Z',
        durationMin: 113,
        tzOffsetMin: 480
      },
      uncovered: [],
      quality: 'draft',
      provenance: 'llm',
      extra: {}
    },
    anchors: null,
    evidence: [],
    pits: [],
    body: `# Ch.${index} 澄清裁决\n\n## 要点\n- x`
  }
}

describe('pits layer (rebuild from cards)', () => {
  it('rebuilds idempotently, single header, escapes pipes, links to cards, marks verified', () => {
    const root = join(fixtureDir, 'pit-root')
    const sessionDir = join(root, '.roadmap', '001', 's1')
    mkdirSync(sessionDir, { recursive: true })
    const card = chapterCard(1, 'one')
    card.pits = [
      {
        text: '罚刚度命名：误读为 45°：认 2a 轨',
        keywords: ['罚刚度', 'K45'],
        symptom: '误读 | 竖线',
        fix: '认 2a 轨',
        seq: 12
      }
    ]
    writeCard(sessionDir, card)
    const first = rebuildPitsIndex(root, new Set([12]))
    expect(first).toContain('KEYWORDS.md')
    const text1 = readFileSync(first!, 'utf8')
    expect((text1.match(/^# /gm) ?? []).length).toBe(1)
    expect(text1).toContain('罚刚度、K45')
    expect(text1).toContain(String.raw`\|`)
    expect(text1).toContain('[Ch.1](../001/s1/001-one.md)')
    expect(text1).toContain('✓')
    rebuildPitsIndex(root, new Set([12]))
    expect(readFileSync(first!, 'utf8')).toBe(text1)
  })
  it('returns null when no structured pits exist', () => {
    expect(rebuildPitsIndex(join(fixtureDir, 'no-such-root'))).toBeNull()
  })
})
