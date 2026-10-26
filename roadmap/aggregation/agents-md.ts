// AGENTS.md managed block — spec agent-retrieval v1.4 §4
// The roadmap protocol text zcode loads into every session's system prompt.
// Managed-block pattern: exact begin/end markers, everything outside is
// preserved byte-for-byte, malformed markers refuse to write (user-data
// protection), pre-write hash check + post-write merge-preserve against
// concurrent external edits.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BLOCK_BEGIN = '<!-- roadmap:begin -->'
export const BLOCK_END = '<!-- roadmap:end -->'

/** The v1 protocol text (spec §4 template, verbatim). */
export function renderRoadmapBlock(): string {
  return `${BLOCK_BEGIN}
<!-- 由 roadmap 聚合器维护，块内编辑会被覆盖；块外内容不受影响 -->
## 项目历史（SessionRoadMap）

本工作区有分层项目传记，开工协议：

1. **先读** \`.roadmap/INDEX.md\` —— 里程碑时间线与项目阶段
2. **再扫** \`.roadmap/pits/KEYWORDS.md\`（坑索引，很小）——把表中关键词与你的任务/涉及文件/工具名对照
3. **命中后**：到 \`.roadmap/pits/DETAILS.md\` 检索该 pit-id（搜索 \`pit-xxxxxx\`，锚点在行首单元格），读命中表格行取解法与溯源；多行命中全读
4. **执行中报错时**：在 \`.roadmap/pits/DETAILS.md\` 里搜索报错信息/文件名/工具名（窗口外老坑靠此通道）
5. **按需下钻**（仅任务相关，沿指针，不枚举目录）：里程碑 \`.roadmap/002/m-*.md\`；章节 \`.roadmap/001/<session>/NNN-*.md\`（INDEX/里程碑内均有指针）
6. **"上次做到哪"**：INDEX 最新里程碑 + 最新 session 最后一张章节卡
7. **只读**：\`.roadmap/\` 对你只读；标记等写操作由用户执行

### 证据锚点语义
章节卡「证据锚点」每条 = messageId/seq + contentHash + 引文。规则：
- 卡有 \`anchorsVerifiedAt\` 或坑详情行 ✓ → **可直接引用**
- 标「未验」且源为 TUI（tui-sqlite）→ **先验证再引用**：按卡内 \`anchors.origin.path\` 打开 DB（默认 \`~/.zcode/cli/db/db.sqlite\`），取 \`message\` 表该 messageId 的 \`data\` 列**原文**（禁任何 parse/stringify/转义），UTF-8 字节 sha256 的十六进制**前 16 字符**（小写）== contentHash 即通过（node/python 一行式；Windows 无 sqlite3 CLI）。验证失败/DB 缺失/哈希不符 → 只能以「未验证」标注使用
- 标「未验」且源为 journal（orca-journal）→ v1 无验证器，以「未验证」标注使用（生成期已验行有 ✓，不受此限）

### 新鲜度
时间线是**历史决策**，非当前分支状态；与 git/文件现状冲突时以现状为准并指出差异。
${BLOCK_END}`
}

function countOf(haystack: string, needle: string): number {
  let n = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++
    i += needle.length
  }
  return n
}

export type EnsureResult = {
  action: 'created' | 'updated' | 'unchanged' | 'appended' | 'refused' | 'aborted'
  message: string
}

/**
 * Ensure the roadmap managed block exists in the workspace-root AGENTS.md.
 * Three states (create / append-when-absent / in-place update), malformed
 * markers refuse, outside bytes preserved, concurrent-edit merge-preserve.
 */
export function ensureAgentsMd(workspaceRoot: string): EnsureResult {
  const path = join(workspaceRoot, 'AGENTS.md')
  const block = renderRoadmapBlock()

  if (!existsSync(path)) {
    const content = `${block}\n\n> 本文件其余部分可自由编辑。\n`
    const tmp = `${path}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
    return { action: 'created', message: `AGENTS.md created with roadmap block` }
  }

  const raw = readFileSync(path, 'utf8')
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom ? raw.slice(1) : raw
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const blockEol = block.replace(/\n/g, eol)

  const beginCount = countOf(body, BLOCK_BEGIN)
  const endCount = countOf(body, BLOCK_END)

  if (beginCount === 0 && endCount === 0) {
    // no markers yet: append the block at the end (one blank line before)
    const base = body.endsWith('\n') || body === '' ? body : `${body}${eol}`
    const nextBody = `${base}${eol}${blockEol}${eol}`
    return commit(path, bom, body, nextBody, blockEol, 'appended')
  }
  if (beginCount !== 1 || endCount !== 1) {
    return {
      action: 'refused',
      message: `AGENTS.md malformed roadmap markers (begin ×${beginCount}, end ×${endCount}); refusing to write — fix markers manually`
    }
  }
  const beginIdx = body.indexOf(BLOCK_BEGIN)
  const endIdx = body.indexOf(BLOCK_END)
  if (beginIdx > endIdx) {
    return {
      action: 'refused',
      message: 'AGENTS.md roadmap markers out of order (end before begin); refusing to write'
    }
  }

  const nextBody = body.slice(0, beginIdx) + blockEol + body.slice(endIdx + BLOCK_END.length)
  return commit(path, bom, body, nextBody, blockEol, 'updated')
}

/** skip-unchanged + pre-write hash check + post-write merge-preserve. */
function commit(
  path: string,
  bom: string,
  originalBody: string,
  nextBody: string,
  blockEol: string,
  action: 'updated' | 'appended'
): EnsureResult {
  const next = `${bom}${nextBody}`
  const raw = `${bom}${originalBody}`

  if (next === raw) {
    return { action: 'unchanged', message: 'AGENTS.md roadmap block unchanged (skip write)' }
  }

  // pre-write check: file changed since first read -> abort
  if (readFileSync(path, 'utf8') !== raw) {
    return {
      action: 'aborted',
      message:
        'AGENTS.md changed concurrently before write; block update aborted (retry next aggregation)'
    }
  }

  const tmp = `${path}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, path)

  // post-write merge-preserve: if the outside region changed during our write
  // window (an external edit got covered), rebuild with the CURRENT outside +
  // our block instead of rolling back (rollback would clobber edits that
  // landed after our write). Block-region external edits are unrecoverable.
  const after = readFileSync(path, 'utf8')
  const afterBody = (after.startsWith('\uFEFF') ? after.slice(1) : after).replace(/\r\n/g, '\n')
  const nextBodyNorm = nextBody.replace(/\r\n/g, '\n')
  const stripBlock = (src: string): string => {
    const b = src.indexOf(BLOCK_BEGIN)
    const e = src.indexOf(BLOCK_END)
    if (b === -1 || e === -1 || b > e) {
      return src
    }
    return src.slice(0, b) + src.slice(e + BLOCK_END.length)
  }
  const beginIdx = afterBody.indexOf(BLOCK_BEGIN)
  const endIdx = afterBody.indexOf(BLOCK_END)
  if (beginIdx !== -1 && endIdx !== -1) {
    // compare the actual outside against the outside WE intended to write —
    // a difference means an external edit landed inside our write window
    const outsideAfter = stripBlock(afterBody)
    const outsideIntended = stripBlock(nextBodyNorm)
    if (outsideAfter !== outsideIntended) {
      const beforeBegin = afterBody.slice(0, beginIdx)
      const afterEnd = afterBody.slice(endIdx + BLOCK_END.length)
      const merged = beforeBegin + blockEol + afterEnd
      const mergeTmp = `${path}.tmp`
      writeFileSync(mergeTmp, `${bom}${merged}`, 'utf8')
      renameSync(mergeTmp, path)
      return {
        action,
        message: `AGENTS.md roadmap block ${action}; concurrent external edit preserved via merge (block-region external changes, if any, were overwritten)`
      }
    }
  }
  return { action, message: `AGENTS.md roadmap block ${action}` }
}
