import { agentArgTerminatorIndex, findAgentArgOption } from './agent-session-option-agent-args'

const STRICT_MCP_CONFIG = '--strict-mcp-config'
const ENTERPRISE_REFUSAL =
  'You cannot use --strict-mcp-config when an enterprise MCP config is present'

function inlineSettings(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : null
  } catch {
    return null
  }
}

/** Apply defaults below the last active user settings value; only the execution host can read files. */
export function isolateClaudeBackgroundArgs(args: readonly string[]): string[] {
  const prepared = [...args]
  let offset = 0
  let winner: { index: number; consumed: number; value?: string } | null = null
  let option = findAgentArgOption('claude', args, ['--settings'])
  while (option) {
    winner = { ...option, index: offset + option.index }
    offset = winner.index + option.consumed
    option = findAgentArgOption('claude', args.slice(offset), ['--settings'])
  }
  if (winner) {
    const settings = winner.value === undefined ? null : inlineSettings(winner.value)
    if (settings) {
      const value = JSON.stringify({ disableAllHooks: true, ...settings })
      prepared.splice(
        winner.index,
        winner.consumed,
        ...(args[winner.index] === '--settings' ? ['--settings', value] : [`--settings=${value}`])
      )
    }
  }
  const defaults = winner ? [] : ['--settings', '{"disableAllHooks":true}']
  if (!findAgentArgOption('claude', args, [STRICT_MCP_CONFIG])) {
    defaults.unshift(STRICT_MCP_CONFIG)
  }
  prepared.splice(agentArgTerminatorIndex('claude', prepared), 0, ...defaults)
  return prepared
}

export type ClaudeBackgroundFailedExit = { exitCode: number | null; stdout: string; stderr: string }

/** Retry the same invocation once, only after Claude's completed enterprise-policy refusal. */
export async function runClaudeBackgroundAttempts<T>(input: {
  agentId: string
  args: readonly string[]
  run: (args: string[]) => Promise<T>
  failedExit: (result: T) => ClaudeBackgroundFailedExit | undefined
}): Promise<T> {
  const result = await input.run([...input.args])
  const failure = input.failedExit(result)
  const strict = findAgentArgOption('claude', input.args, [STRICT_MCP_CONFIG])
  if (
    input.agentId !== 'claude' ||
    !strict ||
    !failure ||
    typeof failure.exitCode !== 'number' ||
    failure.exitCode === 0 ||
    !`${failure.stdout}\n${failure.stderr}`.includes(ENTERPRISE_REFUSAL)
  ) {
    return result
  }
  const retryArgs = [...input.args]
  // Remove active flags only; the same text can be an option value or a positional argument.
  let active = findAgentArgOption('claude', retryArgs, [STRICT_MCP_CONFIG])
  while (active) {
    retryArgs.splice(active.index, 1)
    active = findAgentArgOption('claude', retryArgs, [STRICT_MCP_CONFIG])
  }
  return input.run(retryArgs)
}
