/**
 * The host's own download of the pinned Node archive, tried only when this computer couldn't
 * produce it: many networks give the host a route, or a proxy in its environment, that the
 * desktop lacks. The archive hash is checked here and the promote re-checks the executable, so
 * where the bytes came from never decides what is accepted.
 */
import { copyFile, link, mkdtemp } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  nodeRuntimeReleaseUrl,
  pinnedNodeRuntimeAsset,
  type NodeRuntimeTarget
} from '../../../shared/node-runtime-pin'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  parseRemoteRuntimeExitReport,
  REMOTE_NODE_RUNTIME_EXIT_PREFIX
} from '../../ssh/orcad-remote-node-runtime-report'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { remoteSha256Command } from './remote-sha256-command'

export const HOST_NODE_DOWNLOAD_OK = 'ORCA_NODE_HOST_DOWNLOAD_OK'
export const HOST_NODE_DOWNLOAD_FAILED = 'ORCA_NODE_HOST_DOWNLOAD_FAILED'
export const HOST_NODE_DOWNLOAD_NO_TOOL = 'ORCA_NODE_HOST_DOWNLOAD_NO_TOOL'
export const HOST_NODE_DOWNLOAD_HASH_MISMATCH = 'ORCA_NODE_HOST_DOWNLOAD_HASH_MISMATCH'
/** Each tool's wall-clock cap: ~140 KB/s still fetches the ~58 MB archive. */
const HOST_DOWNLOAD_TOOL_SECONDS = 420
/** Both tools plus the hash, so a tool's own limit always reports before the exec gives up. */
export const HOST_NODE_DOWNLOAD_TIMEOUT_MS = (2 * HOST_DOWNLOAD_TOOL_SECONDS + 60) * 1000

export function hostNodeRuntimeUrl(target: NodeRuntimeTarget): string {
  const asset = pinnedNodeRuntimeAsset(target)
  return nodeRuntimeReleaseUrl(asset.source, asset.archive)
}

/**
 * Downloads into the installer's stage with curl, else wget, keeping the file only if it hashes
 * to the pin. Always exits 0 with a marker, so the caller gets the tool's own words.
 */
export function hostDownloadNodeRuntimeCommand(
  host: RemoteHostPlatform,
  args: { stageDir: string; target: NodeRuntimeTarget }
): string {
  const asset = pinnedNodeRuntimeAsset(args.target)
  const file = quotePosixShell(joinRemotePath(host, args.stageDir, asset.archive))
  const url = quotePosixShell(hostNodeRuntimeUrl(args.target))
  const curl = `curl -fsSL --connect-timeout 20 --max-time ${HOST_DOWNLOAD_TOOL_SECONDS} -o ${file} ${url}`
  // wget has no total-time limit of its own. Probed by running it: old busybox wants `-t SECS`.
  const wget = `$orca_dl_timeout wget -q -T 20 -t 2 -O ${file} ${url}`
  return [
    'orca_dl_status=127; orca_dl_out=; orca_dl_timeout=',
    `timeout 5 true >/dev/null 2>&1 && orca_dl_timeout="timeout ${HOST_DOWNLOAD_TOOL_SECONDS}"`,
    `if command -v curl >/dev/null 2>&1; then orca_dl_out=$(${curl} 2>&1); orca_dl_status=$?; fi`,
    // Why wget after a failed curl: a curl built without TLS or proxy support can fail where wget
    // works. Not after curl's timeout (28): the link is just slow, and wget would be too.
    `if [ "$orca_dl_status" != 0 ] && [ "$orca_dl_status" != 28 ] && command -v wget >/dev/null 2>&1; then ` +
      `orca_dl_out="$orca_dl_out\${orca_dl_out:+; }$(${wget} 2>&1)"; orca_dl_status=$?; fi`,
    `if [ "$orca_dl_status" = 127 ] && [ -z "$orca_dl_out" ]; then echo ${HOST_NODE_DOWNLOAD_NO_TOOL}`,
    `elif [ "$orca_dl_status" != 0 ]; then rm -f ${file}; echo ${HOST_NODE_DOWNLOAD_FAILED}; ` +
      `echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_dl_status"; printf '%s\\n' "$orca_dl_out" | tail -c 2000`,
    `elif [ "$(${remoteSha256Command(file)})" != ${quotePosixShell(asset.archiveSha256)} ]; then ` +
      `rm -f ${file}; echo ${HOST_NODE_DOWNLOAD_HASH_MISMATCH}`,
    `else echo ${HOST_NODE_DOWNLOAD_OK}; fi`
  ].join('\n')
}

export type HostNodeDownloadResult = { ok: true } | { ok: false; report: string }

/** Whether the archive is now in the stage; otherwise the host's reason, in plain words. */
export function readHostNodeDownload(output: string): HostNodeDownloadResult {
  const lines = output.trim().split(/\r?\n/)
  if (lines.at(-1)?.trim() === HOST_NODE_DOWNLOAD_OK) {
    return { ok: true }
  }
  if (lines.some((line) => line.trim() === HOST_NODE_DOWNLOAD_NO_TOOL)) {
    return { ok: false, report: 'it has neither curl nor wget' }
  }
  if (lines.some((line) => line.trim() === HOST_NODE_DOWNLOAD_HASH_MISMATCH)) {
    return {
      ok: false,
      report:
        "it couldn't verify the file as the pinned release, so it was discarded (a proxy or filter may have replaced it, or the host lacks sha256sum and shasum)"
    }
  }
  const failed = output.indexOf(HOST_NODE_DOWNLOAD_FAILED)
  if (failed !== -1) {
    const { exitStatus, output: words } = parseRemoteRuntimeExitReport(output.slice(failed))
    return {
      ok: false,
      report: `its download failed (exit ${exitStatus ?? 'unknown'})${words ? `: ${words}` : ''}`
    }
  }
  return { ok: false, report: `it gave an unexpected reply: ${output.trim().slice(0, 500)}` }
}

/** Neither this computer nor the host could get the pinned archive; says what is left to try. */
export class NodeRuntimeUnreachableError extends Error {
  constructor(
    readonly url: string,
    readonly hostReport: string,
    readonly offlineArchivePath: string | undefined,
    cause: unknown
  ) {
    const desktop = cause instanceof Error ? cause.message : String(cause)
    const offline = offlineArchivePath
      ? `, or download that file on another machine and copy it to ${offlineArchivePath} on this computer.`
      : '.'
    super(
      `Neither this computer nor the host could download Node from ${url}. ` +
        `This computer: ${desktop}. The host: ${hostReport}. ` +
        `Check the network or proxy on either machine and connect again${offline}`,
      { cause }
    )
    this.name = 'NodeRuntimeUnreachableError'
  }
}

/**
 * Runs the host download after this computer's attempt failed with `desktopError`, and returns the
 * archive's name in the stage; throws one error naming both attempts when the host fails too.
 */
export async function downloadNodeRuntimeOnHost(args: {
  exec: (command: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  host: RemoteHostPlatform
  stageDir: string
  target: NodeRuntimeTarget
  desktopError: unknown
  offlineArchivePath?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<string> {
  const output = await args.exec(
    hostDownloadNodeRuntimeCommand(args.host, { stageDir: args.stageDir, target: args.target }),
    { signal: args.signal, timeoutMs: args.timeoutMs }
  )
  const result = readHostNodeDownload(output)
  if (!result.ok) {
    throw new NodeRuntimeUnreachableError(
      hostNodeRuntimeUrl(args.target),
      result.report,
      args.offlineArchivePath,
      args.desktopError
    )
  }
  console.warn(
    `[orcad] This computer couldn't download Node, so the host downloaded it: ${String(args.desktopError)}`
  )
  return pinnedNodeRuntimeAsset(args.target).archive
}

/**
 * Puts the pinned archive in the host stage: this computer's verified copy, uploaded, or else the
 * host's own download. Returns the archive's name there.
 */
export async function stageNodeRuntimeArchive(args: {
  host: RemoteHostPlatform
  target: NodeRuntimeTarget
  stageDir: string
  archivePath: () => Promise<string>
  offlineArchivePath?: string
  exec: (command: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  upload: (localDir: string) => Promise<void>
  /** Receives the local upload directory as soon as it exists, so the caller can remove it. */
  onLocalStage: (localDir: string) => void
  signal?: AbortSignal
}): Promise<{ archive: string }> {
  let archivePath: string
  try {
    archivePath = await args.archivePath()
  } catch (desktopError) {
    // Why any failure: a proxy's block page fails the hash just as a refused connect fails.
    if (isWindowsRemoteHost(args.host) || args.signal?.aborted) {
      throw desktopError
    }
    return {
      archive: await downloadNodeRuntimeOnHost({
        ...args,
        desktopError,
        timeoutMs: HOST_NODE_DOWNLOAD_TIMEOUT_MS
      })
    }
  }
  const uploadDir = await mkdtemp(join(dirname(archivePath), '.runtime-upload-'))
  args.onLocalStage(uploadDir)
  const archive = basename(archivePath)
  await link(archivePath, join(uploadDir, archive)).catch(() =>
    copyFile(archivePath, join(uploadDir, archive))
  )
  await args.upload(uploadDir)
  return { archive }
}
