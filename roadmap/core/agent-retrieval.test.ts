// Tests for agent-retrieval v1.4: AGENTS.md managed block + pits two-tier
// disclosure. Spec acceptance items 1-8, 14 (unit-testable parts).

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLOCK_BEGIN,
  BLOCK_END,
  ensureAgentsMd,
  renderRoadmapBlock
} from '../aggregation/agents-md'
import { serializeCard, type RoadmapCard } from './card'
import {
  rebuildPitsIndex,
  pitIdOf,
  canonicalKeywords,
  symptomOneLiner,
  unionCell,
  INDEX_MAX_CODE_POINTS,
  INDEX_MAX_ROWS
} from './pits-index'

// ─── fixtures ───────────────────────────────────────────────────────────

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-retrieval-'))
}

function writeCard(
  root: string,
  sessionId: string,
  file: string,
  over: {
    index: number
    firstTime?: string
    lastTime?: string
    anchorsVerifiedAt?: string
    pits: { text: string; keywords: string[]; symptom?: string; fix?: string; seq?: number }[]
    evidenceSeqs?: number[]
  }
): void {
  const dir = join(root, '.roadmap', '001', sessionId)
  mkdirSync(dir, { recursive: true })
  const card: RoadmapCard = {
    frontmatter: {
      v: 1,
      kind: 'session-chapter',
      source: 'tui-sqlite',
      session: sessionId,
      workspace: '/tmp/fixture',
      title: `会话 ${sessionId}`,
      chapter: { index: over.index, slug: `chapter-${over.index}` },
      span: { firstMsgSeq: 0, lastMsgSeq: 100, userMsg: { human: 2, total: 4 } },
      time: {
        firstTime: over.firstTime ?? '2026-10-01T10:00:00Z',
        lastTime: over.lastTime ?? '2026-10-01T12:00:00Z',
        durationMin: 120,
        tzOffsetMin: 480
      },
      uncovered: [],
      quality: 'draft',
      provenance: 'llm',
      ...(over.anchorsVerifiedAt ? { anchorsVerifiedAt: over.anchorsVerifiedAt } : {}),
      extra: {}
    },
    anchors: {
      source: 'tui-sqlite',
      origin: { db: 'tui-sqlite', path: '~/.zcode/cli/db/db.sqlite' }
    },
    evidence: (over.evidenceSeqs ?? []).map((seq) => ({
      claim: `坑${seq}`,
      source: 'tui-sqlite',
      origin: { db: 'tui-sqlite', path: '~/.zcode/cli/db/db.sqlite' },
      ref: `msg_fix_${seq}`,
      seq,
      quote: '测试引文',
      contentHash: '0000000000000000',
      hashOf: 'tui-message-data'
    })),
    pits: over.pits.map((pit) => ({
      text: pit.text,
      keywords: pit.keywords,
      ...(pit.symptom ? { symptom: pit.symptom } : {}),
      ...(pit.fix ? { fix: pit.fix } : {}),
      ...(pit.seq !== undefined ? { seq: pit.seq } : {})
    })),
    terms: [],
    body: `# Ch.${over.index} fixture

## 要点
- point`
  }
  writeFileSync(join(dir, file), serializeCard(card), 'utf8')
}

// ─── AGENTS.md managed block ────────────────────────────────────────────

describe('agents-md managed block', () => {
  test('create: absent file -> block + free-edit note', () => {
    const root = tempRoot()
    const r = ensureAgentsMd(root)
    expect(r.action).toBe('created')
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(text).toContain(BLOCK_BEGIN)
    expect(text).toContain(BLOCK_END)
    expect(text).toContain('本文件其余部分可自由编辑')
    rmSync(root, { recursive: true, force: true })
  })

  test('append: existing file without markers -> block appended, outside bytes untouched', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'AGENTS.md'), '# 我的规则\n\n- 用中文回复\n', 'utf8')
    const r = ensureAgentsMd(root)
    expect(r.action).toBe('appended')
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(text.startsWith('# 我的规则\n\n- 用中文回复\n\n')).toBe(true)
    expect(text).toContain(BLOCK_BEGIN)
    rmSync(root, { recursive: true, force: true })
  })

  test('update in place: outside bytes byte-identical, block replaced', () => {
    const root = tempRoot()
    const outside = '# header\n\nuser content\n'
    writeFileSync(
      join(root, 'AGENTS.md'),
      `${outside}${BLOCK_BEGIN}\nold block line\n${BLOCK_END}\ntail\n`,
      'utf8'
    )
    const r = ensureAgentsMd(root)
    expect(r.action).toBe('updated')
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(text.startsWith(outside)).toBe(true)
    expect(text.endsWith('\ntail\n')).toBe(true)
    expect(text).not.toContain('old block line')
    expect(text).toContain('项目历史（SessionRoadMap）')
    rmSync(root, { recursive: true, force: true })
  })

  test('malformed markers refuse to write (user-data protection)', () => {
    for (const bad of [
      `${BLOCK_BEGIN}\nno end marker\n`,
      `orphan end\n${BLOCK_END}\n`,
      `${BLOCK_BEGIN}\na\n${BLOCK_BEGIN}\nb\n${BLOCK_END}\n`,
      `${BLOCK_END}\nwrong order\n${BLOCK_BEGIN}\n`
    ]) {
      const root = tempRoot()
      writeFileSync(join(root, 'AGENTS.md'), bad, 'utf8')
      const r = ensureAgentsMd(root)
      expect(r.action).toBe('refused')
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(bad) // untouched
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('idempotent: second run is unchanged (skip write)', () => {
    const root = tempRoot()
    ensureAgentsMd(root)
    const before = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    const r = ensureAgentsMd(root)
    expect(r.action).toBe('unchanged')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(before)
    rmSync(root, { recursive: true, force: true })
  })

  test('BOM and CRLF preserved outside the block', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'AGENTS.md'), '\uFEFF# 规则\r\n\r\n- 中文\r\n', 'utf8')
    const r = ensureAgentsMd(root)
    expect(r.action).toBe('appended')
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(text.startsWith('\uFEFF# 规则\r\n\r\n- 中文\r\n\r\n')).toBe(true)
    expect(text.includes('\r\n')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})

// ─── pits two-tier ──────────────────────────────────────────────────────

describe('pits two-tier disclosure', () => {
  test('pit-id = keyword-set identity: stable across sessions, independent of seq', () => {
    const a = pitIdOf(['表头', '解析'])
    const b = pitIdOf(['解析', '表头']) // order-insensitive
    const c = pitIdOf(['表头', '解析', '额外'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(canonicalKeywords(['b', 'a', 'a'])).toBe('a、b')
  })

  test('dual-file output: index bounded + details full with anchors; byte-stable rebuild', () => {
    const root = tempRoot()
    writeCard(root, 'sess_a', '001-one.md', {
      index: 1,
      anchorsVerifiedAt: '2026-10-01T00:00:00Z',
      pits: [
        {
          text: '坑甲',
          keywords: ['编码', 'GBK'],
          symptom: '批处理返回 255',
          fix: 'ASCII 注释',
          seq: 10
        },
        { text: '坑乙', keywords: ['锁', '文件'], seq: 11 }
      ],
      evidenceSeqs: [10]
    })
    const r1 = rebuildPitsIndex(root)
    expect(r1).not.toBeNull()
    const kw1 = readFileSync(join(root, '.roadmap', 'pits', 'KEYWORDS.md'), 'utf8')
    const det1 = readFileSync(join(root, '.roadmap', 'pits', 'DETAILS.md'), 'utf8')
    expect(kw1).toContain('pit-')
    expect(kw1).not.toContain('](../001/') // no source links in the index
    expect(det1).toContain(`<!-- ${pitIdOf(['编码', 'GBK'])} -->`)
    expect(det1).toContain('批处理返回 255 → ASCII 注释')
    // 坑甲 verified (card stamp + seq 10 in evidence); 坑乙 unverified (no stamp match)
    expect(det1).toContain('| ✓ |')
    expect(det1).toContain('| 未验 |')
    // byte-stable rebuild
    const r2 = rebuildPitsIndex(root)
    expect(r2?.details).toBeNull() // unchanged
    expect(r2?.keywords).toBeNull()
    expect(readFileSync(join(root, '.roadmap', 'pits', 'DETAILS.md'), 'utf8')).toBe(det1)
    expect(readFileSync(join(root, '.roadmap', 'pits', 'KEYWORDS.md'), 'utf8')).toBe(kw1)
    rmSync(root, { recursive: true, force: true })
  })

  test('cross-session merge: K counts sessions, symptom from latest occurrence', () => {
    const root = tempRoot()
    writeCard(root, 'sess_old', '001-a.md', {
      index: 1,
      firstTime: '2026-09-01T10:00:00Z',
      lastTime: '2026-09-01T12:00:00Z',
      pits: [{ text: '老症状', keywords: ['许可证', 'abaqus'], symptom: '老症状描述', seq: 5 }]
    })
    writeCard(root, 'sess_new', '001-b.md', {
      index: 1,
      firstTime: '2026-10-05T10:00:00Z',
      lastTime: '2026-10-05T12:00:00Z',
      pits: [{ text: '新症状', keywords: ['abaqus', '许可证'], symptom: '新症状描述', seq: 999 }]
    })
    rebuildPitsIndex(root)
    const kw = readFileSync(join(root, '.roadmap', 'pits', 'KEYWORDS.md'), 'utf8')
    expect(kw).toContain('×2')
    expect(kw).toContain('新症状描述')
    expect(kw).not.toContain('老症状描述')
    rmSync(root, { recursive: true, force: true })
  })

  test('window: row cap triggers on short rows; code-point cap triggers on long rows (whole-row boundary)', () => {
    // 45 short pits -> exactly INDEX_MAX_ROWS in the window
    const rootA = tempRoot()
    writeCard(rootA, 'sess_s', '001-s.md', {
      index: 1,
      pits: Array.from({ length: 45 }, (_, i) => ({ text: `t${i}`, keywords: [`kw${i}`], seq: i }))
    })
    rebuildPitsIndex(rootA)
    const rowsA = readFileSync(join(rootA, '.roadmap', 'pits', 'KEYWORDS.md'), 'utf8')
      .split('\n')
      .filter((l) => /^\| pit-[0-9a-f]{6} /.test(l)).length
    expect(rowsA).toBe(INDEX_MAX_ROWS)
    rmSync(rootA, { recursive: true, force: true })

    // few pits with huge keyword unions -> code-point cap binds, whole rows only
    const rootB = tempRoot()
    writeCard(rootB, 'sess_l', '001-l.md', {
      index: 1,
      pits: Array.from({ length: 30 }, (_, i) => ({
        text: `t${i}`,
        keywords: Array.from({ length: 20 }, (_, j) => `关键词组${i}第${j}号条目`), // ~160+ cp per row
        seq: i
      }))
    })
    rebuildPitsIndex(rootB)
    const linesB = readFileSync(join(rootB, '.roadmap', 'pits', 'KEYWORDS.md'), 'utf8')
      .split('\n')
      .filter((l) => /^\| pit-[0-9a-f]{6} /.test(l))
    const cp = (s: string): number => Array.from(s).length
    const total = linesB.reduce((acc, l) => acc + cp(l), 0)
    expect(total).toBeLessThanOrEqual(INDEX_MAX_CODE_POINTS)
    expect(linesB.length).toBeLessThan(30) // cap actually bound
    rmSync(rootB, { recursive: true, force: true })
  })

  test('error-rescan channel: out-of-window pits still greppable in DETAILS', () => {
    const root = tempRoot()
    writeCard(root, 'sess_w', '001-w.md', {
      index: 1,
      pits: Array.from({ length: 45 }, (_, i) => ({
        text: `坑${i}`,
        keywords: [`kw${i}`, `独有线索${i}`],
        symptom: `症状${i}`,
        seq: i
      }))
    })
    rebuildPitsIndex(root)
    const det = readFileSync(join(root, '.roadmap', 'pits', 'DETAILS.md'), 'utf8')
    expect(det).toContain('独有线索44') // the 45th pit left the window but is greppable
    rmSync(root, { recursive: true, force: true })
  })

  test('legacy migration: old single-file renamed aside, never overwritten', () => {
    const root = tempRoot()
    writeCard(root, 'sess_m', '001-m.md', {
      index: 1,
      pits: [{ text: 'x', keywords: ['k'], seq: 1 }]
    })
    const pitsDir = join(root, '.roadmap', 'pits')
    mkdirSync(pitsDir, { recursive: true })
    writeFileSync(
      join(pitsDir, 'KEYWORDS.md'),
      '# 旧格式\n\n| 关键词 | 症状 → 解法 | 溯源 | 验证 |\n|---|---|---|---|\n| 旧坑 | x → y | z | ✓ |\n',
      'utf8'
    )
    writeFileSync(join(pitsDir, 'KEYWORDS.legacy.bak.md'), 'first backup', 'utf8')
    const r = rebuildPitsIndex(root)
    expect(r?.legacyRenamed).toContain('KEYWORDS.legacy.bak.')
    expect(readFileSync(join(pitsDir, 'KEYWORDS.legacy.bak.md'), 'utf8')).toBe('first backup')
    const baks = readdirSync(pitsDir).filter((n) => n.startsWith('KEYWORDS.legacy'))
    expect(baks.length).toBe(2)
    expect(readFileSync(join(pitsDir, 'KEYWORDS.md'), 'utf8')).toContain('pit-') // new index format
    rmSync(root, { recursive: true, force: true })
  })

  test('persistent verification survives a new session build (regression: runtime set)', () => {
    const root = tempRoot()
    writeCard(root, 'sess_old2', '001-o.md', {
      index: 1,
      firstTime: '2026-09-01T10:00:00Z',
      lastTime: '2026-09-01T12:00:00Z',
      anchorsVerifiedAt: '2026-09-01T13:00:00Z',
      pits: [{ text: '老坑', keywords: ['持久'], symptom: 's', fix: 'f', seq: 7 }],
      evidenceSeqs: [7]
    })
    rebuildPitsIndex(root)
    expect(readFileSync(join(root, '.roadmap', 'pits', 'DETAILS.md'), 'utf8')).toContain('| ✓ |')
    // a NEW session's card lands on disk, next rebuild has no runtime verified set at all
    writeCard(root, 'sess_new2', '001-n.md', {
      index: 1,
      firstTime: '2026-10-10T10:00:00Z',
      lastTime: '2026-10-10T12:00:00Z',
      pits: [{ text: '新坑', keywords: ['临时'], seq: 3 }]
    })
    rebuildPitsIndex(root)
    const det = readFileSync(join(root, '.roadmap', 'pits', 'DETAILS.md'), 'utf8')
    expect(det).toContain('| ✓ |') // old session's pit STILL verified
    expect(det).toContain('| 未验 |') // new one has no stamp
    rmSync(root, { recursive: true, force: true })
  })

  test('cell rules: symptom 25cp + ellipsis, union 79cp + ellipsis (surrogate-safe)', () => {
    expect(symptomOneLiner(undefined, 'x'.repeat(30))).toBe(`${'x'.repeat(25)}…`)
    expect(symptomOneLiner('短症状', 'fallback')).toBe('短症状')
    expect(symptomOneLiner('a\r\nb   c', 'f')).toBe('a b c')
    const surrogate = '😀'.repeat(30) // astral, 2 UTF-16 units each
    expect(Array.from(symptomOneLiner(undefined, surrogate)).length).toBe(26) // 25 + ellipsis
    const union = unionCell([Array.from({ length: 100 }, (_, i) => `词${i}`)])
    expect(Array.from(union).length).toBeLessThanOrEqual(80)
    expect(union.endsWith('…')).toBe(true)
  })

  test('DETAILS section order: firstTime asc, dirname tie-break; details written before keywords', () => {
    const root = tempRoot()
    writeCard(root, 'sess_zzz', '001-z.md', {
      index: 1,
      firstTime: '2026-09-01T10:00:00Z',
      lastTime: '2026-09-01T11:00:00Z',
      pits: [{ text: 'a', keywords: ['早'], seq: 1 }]
    })
    writeCard(root, 'sess_aaa', '001-a.md', {
      index: 1,
      firstTime: '2026-10-01T10:00:00Z',
      lastTime: '2026-10-01T11:00:00Z',
      pits: [{ text: 'b', keywords: ['晚'], seq: 1 }]
    })
    writeCard(root, 'sess_bbb', '001-b.md', {
      index: 1,
      firstTime: '2026-09-01T10:00:00Z', // ties sess_zzz -> dirname order zzz < ... wait: 'sess_bbb' < 'sess_zzz'
      lastTime: '2026-09-01T11:00:00Z',
      pits: [{ text: 'c', keywords: ['并列'], seq: 1 }]
    })
    rebuildPitsIndex(root)
    const det = readFileSync(join(root, '.roadmap', 'pits', 'DETAILS.md'), 'utf8')
    const iA = det.indexOf('## sess_aaa')
    const iB = det.indexOf('## sess_bbb')
    const iZ = det.indexOf('## sess_zzz')
    expect(iB).toBeLessThan(iZ) // tie on firstTime -> dirname asc
    expect(iZ).toBeLessThan(iA) // september before october
    rmSync(root, { recursive: true, force: true })
  })
})

// ─── renderRoadmapBlock content sanity ──────────────────────────────────

describe('block template', () => {
  test('contains the retrieval protocol essentials', () => {
    const b = renderRoadmapBlock()
    expect(b).toContain('pits/KEYWORDS.md')
    expect(b).toContain('pits/DETAILS.md')
    expect(b).toContain('pit-xxxxxx')
    expect(b).toContain('anchorsVerifiedAt')
    expect(b).toContain('只读')
    expect(b.startsWith(BLOCK_BEGIN)).toBe(true)
    expect(b.trimEnd().endsWith(BLOCK_END)).toBe(true)
  })
})
