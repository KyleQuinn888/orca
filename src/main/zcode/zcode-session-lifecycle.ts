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

/** What the acquire snapshot says the session runs with, keyed as Orca reads options. */
export function readZcodeSnapshotOptions(snapshot: {
  settings?: Record<string, unknown>
  runtime?: Record<string, unknown>
}): Readonly<Record<string, string>> {
  const options: Record<string, string> = {}
  const mode = snapshot.settings?.mode ?? snapshot.runtime?.mode
  if (typeof mode === 'string' && mode.length > 0) {
    options.mode = mode
  }
  const runtime = snapshot.runtime
  const model =
    typeof runtime === 'object' && runtime !== null
      ? (runtime.modelId ?? (runtime.model as { modelId?: string } | undefined)?.modelId)
      : undefined
  if (typeof model === 'string' && model.length > 0) {
    options.model = model
  }
  const effort =
    typeof runtime === 'object' && runtime !== null
      ? (runtime.reasoningLevel ??
        (runtime.options as { reasoningLevel?: string } | undefined)?.reasoningLevel)
      : undefined
  if (typeof effort === 'string' && effort.length > 0) {
    options.effort = effort
  }
  return options
}

/** One option write over the protocol, mirrored into the session's reported options. */
export async function setZcodeSessionOption(
  session: {
    providerSessionId: string
    connection: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }
    reportedOptions: Record<string, string>
  },
  key: string,
  value: string
): Promise<void> {
  const writes: Record<string, (method: string, params: Record<string, unknown>) => string> = {
    mode: () => 'session/setMode',
    model: () => 'session/setModel',
    effort: () => 'session/setThoughtLevel'
  }
  const params: Record<string, unknown> =
    key === 'mode'
      ? { mode: value }
      : key === 'model'
        ? { model: { modelId: value } }
        : { thoughtLevel: value }
  const method = writes[key]?.(key, params)
  if (method === undefined) {
    throw new Error(`zcode app-server has no session option named ${key}`)
  }
  await session.connection.request(method, {
    sessionId: session.providerSessionId,
    ...params
  })
  session.reportedOptions = { ...session.reportedOptions, [key]: value }
}
