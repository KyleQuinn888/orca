// How a durable session record becomes a `zcode app-server` process launch.
//
// Resume never rides on the launch: the ZCode Protocol resumes through
// `session/resume` once the transport is up, so the launch part only names the
// binary, the workspace and the account home — every input read back from the
// record the store made durable, never from the call that triggered the acquire.

import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { isStableCliVersionOnLine, probeAgentCliVersion } from '../agent-cli-version-probe'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  resolveStructuredAgentCommand
} from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
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

// `zcode --version` prints the runtime version (0.16.9 at the protocol's
// session/subscribe + desktop-continuous delivery), not the npm package's.
const ZCODE_RPC_RELEASE_LINES = [{ major: 0, floor: '0.16.9' }] as const

export function zcodeVersionSupported(
  launch: { command: string; cwd: string; env: Record<string, string> },
  probe: typeof probeAgentCliVersion = probeAgentCliVersion
): Promise<boolean> {
  return probe({ program: launch.command, cwd: launch.cwd, env: launch.env }, (version) =>
    ZCODE_RPC_RELEASE_LINES.some((line) => isStableCliVersionOnLine(version, line))
  )
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
