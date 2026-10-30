// D4: no-tool proof probe (owner ruling D4): the summarizer's PRIMARY path is
// `zcode -p <prompt>` — headless prompt mode, NO tools. Three proofs:
// 1. '-p' is in the spawn args (static inspection of the spawn construction)
// 2. the npm js entry resolves at the packaged-build location
// 3. the spawned CLI reports the pinned version string

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PINNED_VERSION = '3.15.3-36'

const SPAWN_RE = /spawn\([^)]*'-p', prompt\]/

describe('D4: summarizer no-tool mode proof', () => {
  it("spawn args carry '-p' (headless prompt mode, no tools)", () => {
    const src = readFileSync(new URL('./summarizer-launch.ts', import.meta.url), 'utf8')
    // the only spawn construction in the launcher: spawn(cmd, [...prefix, '-p', prompt])
    expect(src.includes("'-p', prompt]")).toBe(true)
    // and nothing else is passed after -p except the prompt itself
    const spawnLine = src.split('\n').find((l) => l.includes('spawn(command.cmd'))
    expect(SPAWN_RE.test(spawnLine ?? '')).toBe(/spawn\([^)]*'-p', prompt\]/)
  })

  it('npm js entry resolves at the packaged-build location', () => {
    const jsEntry = join(
      homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      'zcode-app-cli',
      'bin',
      'zcode.js'
    )
    expect(existsSync(jsEntry)).toBe(true)
  })

  it('spawned CLI reports the pinned version string', () => {
    const jsEntry = join(
      homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      'zcode-app-cli',
      'bin',
      'zcode.js'
    )
    const out = execFileSync('node', [jsEntry, '--version'], { encoding: 'utf8', timeout: 30000 })
    expect(out.split('\n').some((l) => l.trim() === `zcode-app-cli ${PINNED_VERSION}`)).toBe(true)
  })
})
