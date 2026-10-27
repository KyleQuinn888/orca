import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSessionArtifacts } from './session-delete'

function fixtureWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'r2-del-'))
  const rm = join(ws, '.roadmap')
  mkdirSync(join(rm, '001', 'sess-keep'), { recursive: true })
  mkdirSync(join(rm, '001', 'sess-gone'), { recursive: true })
  mkdirSync(join(rm, '002'), { recursive: true })
  writeFileSync(join(rm, '001', 'sess-keep', '001-a.md'), '---\ntitle: keep\n---\nbody')
  writeFileSync(join(rm, '001', 'sess-gone', '001-x.md'), '---\ntitle: gone\n---\nbody')
  writeFileSync(
    join(rm, '002', 'm-keep.md'),
    ['---', 'id: m-keep', 'title: keep-ms', 'sessions:', '  - session: sess-keep', '    chapters: [1]', 'quality: draft', '---'].join('\n')
  )
  writeFileSync(
    join(rm, '002', 'm-gone.md'),
    ['---', 'id: m-gone', 'title: gone-ms', 'sessions:', '  - session: sess-gone', '    chapters: [1]', 'quality: draft', '---'].join('\n')
  )
  writeFileSync(join(rm, 'INDEX.md'), '---\nsessions: 2\nmilestones: 2\nchapters: 2\n---\nold')
  return ws
}

describe('deleteSessionArtifacts', () => {
  it('removes 001 dir, supersedes owned m-cards, rebuilds INDEX counts', async () => {
    const ws = fixtureWorkspace()
    const deps = { getWorkspacePath: (sid: string) => (sid === 'sess-gone' ? ws : null), getUserDataDir: () => ws }
    const r = await deleteSessionArtifacts(deps, 'sess-gone')
    if (!r.ok) {
      throw new Error(r.error ?? 'delete failed')
    }
    expect(existsSync(join(ws, '.roadmap', '001', 'sess-gone'))).toBe(false)
    expect(existsSync(join(ws, '.roadmap', '001', 'sess-keep'))).toBe(true)
    const goneCard = readFileSync(join(ws, '.roadmap', '002', 'm-gone.md'), 'utf-8')
    expect(goneCard.includes('quality: superseded')).toBe(true)
    const keepCard = readFileSync(join(ws, '.roadmap', '002', 'm-keep.md'), 'utf-8')
    expect(keepCard.includes('quality: draft')).toBe(true)
    const index = readFileSync(join(ws, '.roadmap', 'INDEX.md'), 'utf-8')
    expect(index.includes('sessions: 1')).toBe(true)
    expect(index.includes('milestones: 1')).toBe(true)
    expect(index.includes('chapters: 1')).toBe(true)
    rmSync(ws, { recursive: true, force: true })
  })

  it('refuses invalid ids and unknown workspaces', async () => {
    const ws = fixtureWorkspace()
    const deps = { getWorkspacePath: () => ws, getUserDataDir: () => ws }
    const bad = await deleteSessionArtifacts(deps, '../escape')
    expect(bad.ok).toBe(false)
    const none = await deleteSessionArtifacts({ getWorkspacePath: () => null, getUserDataDir: () => ws }, 'sess-gone')
    expect(none.ok).toBe(false)
    expect(none.error).toBe('workspace unavailable')
    rmSync(ws, { recursive: true, force: true })
  })

  it('is idempotent: second run succeeds with everything already gone', async () => {
    const ws = fixtureWorkspace()
    const deps = { getWorkspacePath: (sid: string) => (sid === 'sess-gone' ? ws : null), getUserDataDir: () => ws }
    await deleteSessionArtifacts(deps, 'sess-gone')
    const again = await deleteSessionArtifacts(deps, 'sess-gone')
    expect(again.ok).toBe(true)
    rmSync(ws, { recursive: true, force: true })
  })
})
