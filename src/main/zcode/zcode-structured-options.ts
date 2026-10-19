// The option surface of a live or resting zcode session: what the acquire
// snapshot reported, shaped as Orca's option and command readers answer it.

import type {
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import { permissionForZcodeMode } from './zcode-session-lifecycle'

type ZcodeOptionsSession = {
  reportedOptions: Record<string, string>
  reportedModels: { id: string; label: string }[]
  reportedEfforts: Map<string, { value: string; label: string }[]>
  reportedCommands: { name: string; description?: string; argumentHint?: string }[]
}

export function readZcodeLiveOptions(session: ZcodeOptionsSession): AgentSessionOptionsResult {
  const result: AgentSessionOptionsResult = {
    current: {
      ...session.reportedOptions,
      ...(session.reportedOptions.mode !== undefined
        ? { permissionMode: permissionForZcodeMode(session.reportedOptions.mode) }
        : {})
    },
    models: []
  }
  const currentModel = session.reportedOptions.model
  if (session.reportedModels.length > 0) {
    result.models = session.reportedModels.map((model) => ({
      id: model.id,
      label: model.label,
      isDefault: model.id === currentModel,
      efforts: (session.reportedEfforts.get(model.id) ?? []).map((effort) => ({
        value: effort.value,
        label: effort.label
      }))
    }))
  } else if (currentModel !== undefined) {
    result.models = [{ id: currentModel, label: currentModel, isDefault: true, efforts: [] }]
  }
  return result
}

export function readZcodeRestingOptions(
  session: ZcodeOptionsSession | undefined,
  priorOptions?: Readonly<Record<string, string>>
): Readonly<Record<string, string>> | undefined {
  if (session) {
    const options = { ...session.reportedOptions }
    return Object.keys(options).length > 0 ? options : undefined
  }
  return priorOptions
}

export function readZcodeCommands(
  session: ZcodeOptionsSession | undefined
): AgentSessionSlashCommand[] | undefined {
  if (!session || session.reportedCommands.length === 0) {
    return undefined
  }
  return session.reportedCommands.map((command) => ({
    name: command.name,
    kind: 'command' as const,
    ...(command.description ? { description: command.description } : {}),
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {})
  }))
}
