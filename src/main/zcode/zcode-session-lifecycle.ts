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

/** What the acquire snapshot says the session runs with, keyed as Orca reads options.
 *  Live-verified paths: `settings.mode.current`, `settings.model.current.modelId`,
 *  `settings.thoughtLevel.current`, `settings.permission.mode`. */
export function readZcodeSnapshotOptions(snapshot: {
  settings?: Record<string, unknown>
}): Readonly<Record<string, string>> {
  const options: Record<string, string> = {}
  const settings = snapshot.settings
  const mode = readCurrent(settings?.mode) ?? readCurrent(settings?.permission)
  if (typeof mode === 'string') {
    options.mode = mode
  }
  const model = readCurrent(settings?.model) as { modelId?: string } | undefined
  if (typeof model?.modelId === 'string' && model.modelId.length > 0) {
    options.model = model.modelId
  }
  const effort = readCurrent(settings?.thoughtLevel)
  if (typeof effort === 'string') {
    options.effort = effort
  }
  return options
}

/** The provider's model listing as Orca picker options, `{modelId, label}` each. */
export function readZcodeSnapshotModels(snapshot: {
  settings?: Record<string, unknown>
}): { id: string; label: string }[] {
  const settings = snapshot.settings
  // `settings.model` IS the container ({available, current, lastUsed}); unwrapping
  // `.current` here would lose the listing.
  const available = settings?.model as { available?: unknown } | undefined
  const listing = Array.isArray(available?.available) ? (available?.available ?? []) : []
  const models: { id: string; label: string }[] = []
  for (const entry of listing) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    // Entries carry `{ref: {providerId, modelId}, label}` — the id lives in ref.
    const ref = (entry as { ref?: { modelId?: unknown } }).ref
    const id =
      (ref && typeof ref.modelId === 'string' && ref.modelId.length > 0
        ? ref.modelId
        : undefined) ??
      (entry as { modelId?: unknown }).modelId ??
      (entry as { id?: unknown }).id
    const label = (entry as { label?: unknown }).label ?? (entry as { name?: unknown }).name
    if (typeof id === 'string' && id.length > 0) {
      models.push({ id, label: typeof label === 'string' && label.length > 0 ? label : id })
    }
  }
  return models
}

/** Each model's reasoning levels as Orca effort choices. */
export function readZcodeSnapshotEfforts(snapshot: {
  settings?: Record<string, unknown>
}): Map<string, { value: string; label: string }[]> {
  const settings = snapshot.settings
  const available = settings?.model as { available?: unknown } | undefined
  const efforts = new Map<string, { value: string; label: string }[]>()
  const listing = Array.isArray(available?.available) ? (available?.available ?? []) : []
  for (const entry of listing) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const modelId = (entry as { ref?: { modelId?: unknown } }).ref?.modelId
    if (typeof modelId !== 'string' || modelId.length === 0) {
      continue
    }
    const levels = (entry as { reasoning?: { levels?: unknown } }).reasoning?.levels
    if (!Array.isArray(levels)) {
      continue
    }
    const choices: { value: string; label: string }[] = []
    for (const level of levels) {
      if (typeof level !== 'object' || level === null) {
        continue
      }
      const value = (level as { value?: unknown }).value
      const label = (level as { label?: unknown }).label
      if (typeof value === 'string' && value.length > 0) {
        choices.push({ value, label: typeof label === 'string' ? label : value })
      }
    }
    if (choices.length > 0) {
      efforts.set(modelId, choices)
    }
  }
  return efforts
}

function readCurrent(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'object' && value !== null && 'current' in value) {
    return (value as { current: unknown }).current
  }
  return undefined
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
  // The picker speaks Orca permission modes (ask/full-access); the protocol speaks its own.
  const mode = key === 'mode' ? (zcodeModeForPermission(value) ?? value) : value
  const params: Record<string, unknown> =
    key === 'mode'
      ? { mode }
      : key === 'model'
        ? { model: { modelId: mode } }
        : { thoughtLevel: mode }
  const method = writes[key]?.(key, params)
  if (method === undefined) {
    throw new Error(`zcode app-server has no session option named ${key}`)
  }
  await session.connection.request(method, {
    sessionId: session.providerSessionId,
    ...params
  })
  session.reportedOptions = { ...session.reportedOptions, [key]: mode }
}

/** Where the snapshot's own event stream stands; subscribe replays after it. */
export function readZcodeSnapshotEventSeq(snapshot: { runtime?: Record<string, unknown> }): number {
  const seq = snapshot.runtime?.eventSeq
  return typeof seq === 'number' && Number.isFinite(seq) && seq >= 0 ? seq : 0
}

/** Orca permission modes (ask/full-access) to zcode protocol modes. */
export function zcodeModeForPermission(permission: string): string | undefined {
  if (permission === 'full-access') {
    return 'yolo'
  }
  if (permission === 'ask') {
    return 'build'
  }
  return undefined
}

/** Zcode protocol modes to Orca permission modes; absent means no picker state. */
export function permissionForZcodeMode(mode: string): string | undefined {
  if (mode === 'yolo' || mode === 'guarded') {
    return 'full-access'
  }
  if (mode === 'build' || mode === 'edit' || mode === 'plan') {
    return 'ask'
  }
  return undefined
}
