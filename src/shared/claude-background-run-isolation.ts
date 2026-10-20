// Why: Orca's background Claude runs (model and `/` listings, chat naming, commit messages) only
// produce text. Loading the user's MCP servers starts every server just to stop it, and can cut
// off an OAuth refresh mid-flight; their hooks would fire on every run. Strict mode drops every
// server not passed explicitly, whatever allowlists other settings sources hold.

const STRICT_MCP_CONFIG = '--strict-mcp-config'
const HOOKS_OFF = { disableAllHooks: true }

export const CLAUDE_BACKGROUND_RUN_ARGS = [
  STRICT_MCP_CONFIG,
  '--settings',
  JSON.stringify(HOOKS_OFF)
] as const

function inlineSettings(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : null
  } catch {
    return null
  }
}

/** Isolates a background run whose argv includes the user's own flags. Claude keeps only the
 *  last `--settings`, so inline user settings merge into one object over hooks-off; a settings
 *  file is left as written, since only the executing host can read it. */
export function isolateClaudeBackgroundArgs(args: readonly string[]): string[] {
  const rest: string[] = []
  const settings: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings' && i + 1 < args.length) {
      settings.push(args[++i])
    } else if (args[i].startsWith('--settings=')) {
      settings.push(args[i].slice('--settings='.length))
    } else {
      rest.push(args[i])
    }
  }
  const parsed = settings.map(inlineSettings)
  const merged = parsed.every((value) => value !== null)
    ? ['--settings', JSON.stringify(Object.assign({ ...HOOKS_OFF }, ...parsed))]
    : null
  return [
    ...(merged ? rest : [...args]),
    ...(args.includes(STRICT_MCP_CONFIG) ? [] : [STRICT_MCP_CONFIG]),
    ...(merged ?? [])
  ]
}

/** Whether Claude refused strict mode because an enterprise MCP config is present. That config
 *  already keeps the user's own servers out, and Claude, not Orca, decides where it lives on each
 *  host (WSL can inherit Windows policy), so the run is retried once without the flag. */
export function claudeRefusedStrictMcpConfig(output: string): boolean {
  return output.includes(STRICT_MCP_CONFIG) && /enterprise MCP config/i.test(output)
}

export function withoutStrictMcpConfig(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== STRICT_MCP_CONFIG)
}
