// How a durable session record becomes a `zcode app-server` process launch.
//
// Resume never rides on the launch: the ZCode Protocol resumes through
// `session/resume` once the transport is up, so the launch part only names the
// binary, the workspace and the account home — every input read back from the
// record the store made durable, never from the call that triggered the acquire.

import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { probeAgentCliVersion } from '../agent-cli-version-probe'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  resolveStructuredAgentCommand
} from '../native-chat/structured-agent-command-resolution'
import type {
  StructuredAgentLaunchPartResolver,
  StructuredAgentLaunchResolver
} from '../runtime/structured-agent-launch-composition'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { ZcodeAppServerLaunch } from './zcode-app-server-connection'

export type ZcodeStructuredLaunch = ZcodeAppServerLaunch & {
  /** The provider session this acquire resumes; null starts one. */
  resumeSessionId: string | null
}

export type ZcodeStructuredLaunchPartDeps = {
  /** Extra args ahead of `app-server`, from the user's agent launch settings. */
  resolveLaunchArgs: () => Promise<string[]> | string[]
  /** Overridden in tests; production scans the boot-cached PATH and version-manager dirs. */
  resolveCommand?: typeof resolveCliCommand
}

export type ZcodeStructuredInvocationDeps = Pick<
  ZcodeStructuredLaunchPartDeps,
  'resolveCommand'
> & {
  /** Fresh shell/configured environment for this spawn; never written to the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Rereads that environment when ZCode is not found in it; absent never retries. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Where the program starts, for a PATH entry relative to it; Orca's own when absent. */
  resolveWorkingDirectory?: () => Promise<string> | string
}

export type ZcodeStructuredInvocation = {
  command: string
  environment: NodeJS.ProcessEnv | undefined
}

/** The one place a structured ZCode child's binary is resolved, so the session
 *  launch and the session-less version probe can never disagree. */
export function resolveZcodeStructuredInvocation(
  deps: ZcodeStructuredInvocationDeps
): Promise<ZcodeStructuredInvocation> {
  return resolveAgainAfterRefreshOnMissingProgram(
    () => readZcodeStructuredInvocation(deps),
    deps.refreshEnvironmentAfterMiss,
    { env: ({ environment }) => environment, cwd: deps.resolveWorkingDirectory }
  )
}

async function readZcodeStructuredInvocation(
  deps: ZcodeStructuredInvocationDeps
): Promise<ZcodeStructuredInvocation> {
  const environment = await deps.resolveEnvironment?.()
  const pathEnv = environment?.PATH ?? environment?.Path ?? null
  const homePath = environment?.HOME ?? environment?.USERPROFILE
  const command = resolveStructuredAgentCommand(
    'zcode',
    {},
    { pathEnv, ...(homePath ? { homePath } : {}) },
    deps.resolveCommand ? { resolve: deps.resolveCommand } : {}
  )
  return { command, environment }
}

// `zcode --version` prints `zcode-app-cli 3.15.3-36` (the npm package's version,
// build-suffixed) before its runtime line, and the probe reads the first semver.
// ZCode's `-NN` is a build number, not a prerelease, so the shared stable-line
// gate would refuse every release; the floor is the oldest package that speaks
// session/subscribe with desktop-continuous delivery.
const ZCODE_MIN_APP_CLI_VERSION = { major: 3, minor: 14, patch: 5 } as const

function zcodeVersionReached(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) {
    return false
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const floor = ZCODE_MIN_APP_CLI_VERSION
  return (
    major > floor.major ||
    (major === floor.major &&
      (minor > floor.minor || (minor === floor.minor && patch >= floor.patch)))
  )
}

export function zcodeVersionSupported(
  launch: { command: string; cwd: string; env: Record<string, string> },
  probe: typeof probeAgentCliVersion = probeAgentCliVersion
): Promise<boolean> {
  return probe({ program: launch.command, cwd: launch.cwd, env: launch.env }, zcodeVersionReached)
}

/** ZCode's part of a launch: its binary and the account home; the workspace
 *  cwd is composition's to seal. */
export function zcodeStructuredLaunchPart(
  deps: ZcodeStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<ZcodeStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const { command } = await resolveZcodeStructuredInvocation({
      ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: basis.launchDirectory,
      resolveEnvironment: basis.environment
    })
    const environment = await basis.environment()
    const args = await deps.resolveLaunchArgs()
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    return {
      launch: {
        command,
        args: [...args, 'app-server'],
        // An empty chain never proved a session, so the adapter starts one; anything
        // else resumes the last link this session proved over the protocol.
        resumeSessionId: head?.handle.nativeId ?? null
      },
      env: {
        ...compactEnv(environment),
        ...(accountHome.path ? { ZCODE_STORAGE_DIR: accountHome.path } : {})
      },
      inheritedEnvToDelete: []
    }
  }
}

/** NodeJS.ProcessEnv carries `undefined` values a Record<string,string> cannot. */
function compactEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const compacted: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      compacted[key] = value
    }
  }
  return compacted
}

/** Check every acquired child against the same launch the app-server will use. */
export function withSupportedZcodeCli<L extends ProviderProcessLaunch>(
  resolveLaunch: StructuredAgentLaunchResolver<L>
): StructuredAgentLaunchResolver<L> {
  return async (request) => {
    const launch = await resolveLaunch(request)
    if (!(await zcodeVersionSupported({ ...launch, env: launch.env }))) {
      throw new Error('zcode CLI 0.16.9+ with app-server support is required')
    }
    return launch
  }
}
