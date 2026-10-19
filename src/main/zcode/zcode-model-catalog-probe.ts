// The zcode model catalog probe: a one-shot `zcode app-server` child that
// creates a session, reads the snapshot's model listing, then closes. The
// picker's catalog gate stays shut without a listing, which also blocked the
// live options read — so this probe unlocks both.

import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { AgentModelCatalogSuccess } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import type { AgentModelCatalogProbe } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { openZcodeAppServerConnection } from './zcode-app-server-connection'
import { readZcodeSnapshotEfforts, readZcodeSnapshotModels } from './zcode-session-lifecycle'

const PROBE_TIMEOUT_MS = 30_000

export function createZcodeModelCatalogProbe(deps: {
  resolveLaunch: () => Promise<{ command: string; env?: Record<string, string> }>
}): AgentModelCatalogProbe {
  return async (
    _accountHome,
    options?: { signal?: AbortSignal; workspacePath?: string }
  ): Promise<AgentModelCatalogSuccess> => {
    const launch = await deps.resolveLaunch()
    console.info(`[zcode-probe] listing via ${launch.command}`)
    const connection = await openZcodeAppServerConnection({
      command: launch.command,
      args: ['app-server'],
      env: launch.env,
      cwd: options?.workspacePath
    })
    try {
      const snapshot = (await connection.request(
        'session/create',
        {
          workspace: {
            workspacePath: options?.workspacePath ?? process.cwd(),
            workspaceKey: 'catalog-probe'
          },
          mode: 'build'
        },
        { timeoutMs: PROBE_TIMEOUT_MS }
      )) as { session?: { sessionId?: string }; settings?: Record<string, unknown> }
      const sessionId = snapshot.session?.sessionId
      if (typeof sessionId === 'string') {
        await connection.request('session/close', { sessionId }).catch(() => undefined)
      }
      const efforts = readZcodeSnapshotEfforts(snapshot)
      const models: AgentSessionModelOption[] = readZcodeSnapshotModels(snapshot).map((model) => ({
        id: model.id,
        label: model.label,
        isDefault: false,
        efforts: (efforts.get(model.id) ?? []).map((effort) => ({
          value: effort.value,
          label: effort.label
        }))
      }))
      console.info(`[zcode-probe] listed ${models.length} models`)
      return { models, origin: 'probe' }
    } catch (error) {
      console.info(
        `[zcode-probe] failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    } finally {
      await connection.close()
    }
  }
}
