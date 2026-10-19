import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import { isNativeLocalLocation } from '../../shared/execution-host'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { ZCODE_SESSION_HISTORY } from '../native-chat/zcode-cli-conversations'
import { applyStructuredCodexWorkspaceTrust } from '../agent-workspace-trust-spawn'
import { ACP_LAUNCH_SPECS, type AcpLaunchSpec } from '../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../acp/acp-structured-agent-definitions'
import {
  acpLaunchVersionSupported,
  resolveAcpLaunchCommand
} from '../acp/acp-structured-launch-resolution'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { ZCODE_STRUCTURED_AGENT } from '../zcode/zcode-structured-agent-definition'
import { zcodeVersionSupported } from '../zcode/zcode-structured-launch-resolution'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { CLAUDE_CLI_CONVERSATIONS } from '../claude/claude-cli-conversations'
import { CODEX_CLI_CONVERSATIONS } from '../codex/codex-cli-conversations'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import { supportsClaudeStructuredLocation } from '../claude/claude-structured-location-support'
import { supportsAcpStructuredLocation } from '../acp/acp-structured-location-support'
import { PI_RPC_RUNTIME_METADATA } from '../pi/rpc-runtime-metadata'
import {
  resolveStructuredClaudeAccountHomePath,
  resolveStructuredCodexAccountHomePath
} from './structured-agent-account-home'
import {
  acpModelCatalogDiscovery,
  claudeModelCatalogDiscovery,
  codexModelCatalogDiscovery
} from './structured-agent-model-catalog-discovery'
import type {
  StructuredAgentAccountHomeRequest,
  StructuredAgentAccountHomeServices,
  StructuredAgentRuntimeMetadata
} from './structured-agent-runtime-registration-types'

export type StructuredAgentRuntimeCatalogEntry =
  | { kind: 'pi' | 'codex' | 'claude' | 'zcode'; metadata: StructuredAgentRuntimeMetadata }
  | { kind: 'acp'; metadata: StructuredAgentRuntimeMetadata; spec: AcpLaunchSpec }

function acpMetadata(spec: AcpLaunchSpec): StructuredAgentRuntimeMetadata {
  return {
    definition: acpStructuredAgentDefinition(spec),
    supportsLocation: (location) => supportsAcpStructuredLocation(spec, location),
    ...(spec.supportsVersion
      ? {
          launchCheck: {
            resolveLaunch: (shellEnv, commandSettings) => {
              const env = { ...shellEnv, ...spec.env }
              const command = resolveAcpLaunchCommand(spec, env, {
                commandSettings,
                dataDirectory: null
              })
              return { command, env }
            },
            supportsVersion: (launch) => acpLaunchVersionSupported(spec, launch)
          }
        }
      : {}),
    resolveAccountHome: ({ launchEnv }, { stateDirectory }) =>
      spec.account.resolve({ launchEnv, stateDirectory }),
    modelCatalog: (context) => acpModelCatalogDiscovery(spec, context),
    transcriptImport: spec.transcriptImport,
    sessionHistory: spec.sessionHistory
  }
}

async function resolveCodexAccountHomePath(
  request: StructuredAgentAccountHomeRequest,
  services: StructuredAgentAccountHomeServices
): Promise<string> {
  const { launchEnv, purpose, workspacePath } = request
  if (purpose === 'launch' && workspacePath) {
    await applyStructuredCodexWorkspaceTrust({
      workspacePath: await workspacePath(),
      launchEnv,
      settings: services.workspaceTrustSettings()
    })
  }
  return resolveStructuredCodexAccountHomePath({
    launchEnv,
    resolveLaunchHome:
      purpose === 'launch' ? services.prepareCodexLaunchHome : services.readCodexLaunchHome
  })
}

// One roster supplies both metadata readers and the host's synchronous adapter factories.
export const STRUCTURED_AGENT_RUNTIME_CATALOG: readonly StructuredAgentRuntimeCatalogEntry[] = [
  { kind: 'pi', metadata: PI_RPC_RUNTIME_METADATA },
  {
    kind: 'codex',
    metadata: {
      definition: CODEX_STRUCTURED_AGENT,
      modelCatalog: codexModelCatalogDiscovery,
      ...CODEX_CLI_CONVERSATIONS,
      supportsLocation: (location) => supportsCodexStructuredLocation(location),
      resolveAccountHome: async (request, services) =>
        agentSessionAccountHome(
          CODEX_STRUCTURED_AGENT,
          await resolveCodexAccountHomePath(request, services)
        )
    }
  },
  {
    kind: 'claude',
    metadata: {
      definition: CLAUDE_STRUCTURED_AGENT,
      modelCatalog: claudeModelCatalogDiscovery,
      ...CLAUDE_CLI_CONVERSATIONS,
      supportsLocation: supportsClaudeStructuredLocation,
      resolveAccountHome: async ({ launchEnv, location }, services) =>
        agentSessionAccountHome(
          CLAUDE_STRUCTURED_AGENT,
          resolveStructuredClaudeAccountHomePath({
            launchEnv,
            wslDistro: location?.wslDistro ?? null,
            getClaudeConfigDirectory: services.getClaudeConfigDirectory
          })
        )
    }
  },
  {
    kind: 'zcode',
    metadata: {
      definition: ZCODE_STRUCTURED_AGENT,
      // v1 adopts no CLI-recorded conversations; Session History rows still resolve by agent id.
      transcriptImport: null,
      sessionHistory: ZCODE_SESSION_HISTORY,
      // v1 lists no models away from a session: the acquire snapshot owns what runs.
      modelCatalog: () => ({
        kind: 'unavailable',
        reason: 'zcode reports its model on the session snapshot'
      }),
      supportsLocation: (location) => isNativeLocalLocation(location),
      launchCheck: {
        resolveLaunch: (shellEnv, commandSettings) => ({
          command: resolveStructuredAgentCommand('zcode', commandSettings, {
            pathEnv: shellEnv.PATH ?? shellEnv.Path ?? null
          }),
          env: shellEnv
        }),
        supportsVersion: zcodeVersionSupported
      },
      resolveAccountHome: async ({ launchEnv }) =>
        agentSessionAccountHome(
          ZCODE_STRUCTURED_AGENT,
          launchEnv.ZCODE_STORAGE_DIR?.trim() || join(homedir(), '.zcode')
        )
    }
  },
  ...ACP_LAUNCH_SPECS.map((spec): StructuredAgentRuntimeCatalogEntry => ({
    kind: 'acp',
    metadata: acpMetadata(spec),
    spec
  }))
]

export const STRUCTURED_AGENT_RUNTIME_METADATA: readonly StructuredAgentRuntimeMetadata[] =
  STRUCTURED_AGENT_RUNTIME_CATALOG.map(({ metadata }) => metadata)

/** The metadata of `agent`, without constructing its adapter or installing the host. */
export function structuredAgentRuntimeMetadata(
  agent: string
): StructuredAgentRuntimeMetadata | null {
  return (
    STRUCTURED_AGENT_RUNTIME_METADATA.find(({ definition }) => definition.agent === agent) ?? null
  )
}
