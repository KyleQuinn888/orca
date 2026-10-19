// The acquire's provider half: create or resume the session the launch names,
// as one bounded step with its own (longer) deadline.

import type { ZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'
import type { ComposedStructuredLaunch } from '../runtime/structured-agent-launch-composition'

const ZCODE_ACQUIRE_TIMEOUT_MS = 60_000

/** create-or-resume plus the initial settings read, as one acquire step. */
export async function zcodeSessionLifecycle(
  connection: ZcodeAppServerConnection,
  launch: ComposedStructuredLaunch<ZcodeStructuredLaunch>,
  resumeSessionId: string | null,
  options: Readonly<Record<string, string>> | undefined
): Promise<unknown> {
  const timeout = { timeoutMs: ZCODE_ACQUIRE_TIMEOUT_MS }
  const workspace = {
    workspacePath: launch.cwd,
    workspaceKey: launch.cwd.replaceAll('\\', '/').split('/').pop() ?? launch.cwd
  }
  const mode = options?.mode ?? 'build'
  if (resumeSessionId) {
    return await connection.request(
      'session/resume',
      { sessionId: resumeSessionId, workspace },
      timeout
    )
  }
  return await connection.request('session/create', { workspace, mode }, timeout)
}
