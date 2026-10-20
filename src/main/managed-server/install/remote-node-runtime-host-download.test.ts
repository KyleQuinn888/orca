import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { NODE_RUNTIME_ASSETS } from '../../../shared/node-runtime-pin'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  hostDownloadNodeRuntimeCommand,
  hostNodeRuntimeUrl,
  readHostNodeDownload
} from './remote-node-runtime-host-download'

const TARGET = 'linux-x64-glibc'
const host = getRemoteHostPlatform('linux-x64')
const PAYLOAD = 'pinned node archive bytes'
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
const directories: string[] = []

beforeEach(() => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], {
    archiveSha256: createHash('sha256').update(PAYLOAD).digest('hex')
  })
})
afterEach(() => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function which(tool: string): string | null {
  const result = runProcessSync({ program: '/bin/sh', args: ['-c', `command -v ${tool}`] })
  return result.code === 0 ? result.stdout.trim() : null
}

/** A host whose PATH holds only the shell basics plus the given download-tool shims. */
function fakeHost(tools: Record<string, string>): { bin: string; stage: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-host-download-'))
  directories.push(root)
  const bin = join(root, 'bin')
  const stage = join(root, 'stage')
  mkdirSync(bin)
  mkdirSync(stage)
  for (const basic of ['cut', 'rm', 'tail', 'sha256sum', 'shasum', 'perl']) {
    const resolved = which(basic)
    if (resolved) {
      symlinkSync(resolved, join(bin, basic))
    }
  }
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  return { bin, stage }
}

// Writes `$1` to the file after the given output flag, wherever it appears in argv.
const writeTo = (flag: string, content: string): string =>
  `while [ $# -gt 0 ]; do if [ "$1" = ${flag} ]; then printf '%s' '${content}' > "$2"; fi; shift; done`

function runOnHost(bin: string, stage: string): string {
  const result = runProcessSync({
    program: '/bin/sh',
    args: ['-c', hostDownloadNodeRuntimeCommand(host, { stageDir: stage, target: TARGET })],
    env: { PATH: bin },
    timeoutMs: 30_000
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

describe.skipIf(process.platform === 'win32')('the host-side pinned Node download', () => {
  it('downloads the pinned URL with curl and keeps the verified archive', () => {
    const { bin, stage } = fakeHost({
      curl: `echo "$@" > "\${0%/*}/curl.args"\n${writeTo('-o', PAYLOAD)}`
    })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({ ok: true })
    expect(existsSync(join(stage, originalAsset.archive))).toBe(true)
    expect(
      runProcessSync({ program: '/bin/cat', args: [join(bin, 'curl.args')] }).stdout
    ).toContain(hostNodeRuntimeUrl(TARGET))
  })

  it('falls back to wget when curl fails', () => {
    const { bin, stage } = fakeHost({
      curl: "echo 'curl: (35) TLS connect error' >&2; exit 35",
      wget: writeTo('-O', PAYLOAD)
    })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({ ok: true })
  })

  it('does not start wget after curl ran out of time, so both fit the exec limit', () => {
    const { bin, stage } = fakeHost({
      curl: "echo 'curl: (28) Operation timed out' >&2; exit 28",
      wget: `touch "\${0%/*}/wget.ran"; ${writeTo('-O', PAYLOAD)}`
    })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toMatchObject({
      ok: false,
      report: expect.stringContaining('exit 28')
    })
    expect(existsSync(join(bin, 'wget.ran'))).toBe(false)
  })

  it('discards a file that is not the pinned release', () => {
    const { bin, stage } = fakeHost({ curl: writeTo('-o', '<html>blocked by policy</html>') })
    const result = readHostNodeDownload(runOnHost(bin, stage))
    expect(result).toMatchObject({ ok: false, report: expect.stringContaining('pinned release') })
    expect(existsSync(join(stage, originalAsset.archive))).toBe(false)
  })

  it("reports the tool's own words when every download fails", () => {
    const { bin, stage } = fakeHost({
      curl: "echo 'curl: (7) Failed to connect to nodejs.org port 443' >&2; exit 7"
    })
    const result = readHostNodeDownload(runOnHost(bin, stage))
    expect(result).toEqual({
      ok: false,
      report: 'its download failed (exit 7): curl: (7) Failed to connect to nodejs.org port 443'
    })
  })

  it('says so when the host has neither curl nor wget', () => {
    const { bin, stage } = fakeHost({})
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({
      ok: false,
      report: 'it has neither curl nor wget'
    })
  })
})
