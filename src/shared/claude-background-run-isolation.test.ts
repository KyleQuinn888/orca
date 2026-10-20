import { expect, it, vi } from 'vitest'
import {
  isolateClaudeBackgroundArgs,
  runClaudeBackgroundAttempts
} from './claude-background-run-isolation'

it('distinguishes active options from required values and positional arguments', () => {
  const input = [
    '--system-prompt',
    '--settings',
    '--model',
    '--strict-mcp-config',
    '--',
    '--settings',
    'positional.json'
  ]
  expect(isolateClaudeBackgroundArgs(input)).toEqual([
    ...input.slice(0, 4),
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
    ...input.slice(4)
  ])
})

it('retries only a canonical nonzero completed exit, at most twice', async () => {
  const canonical = 'You cannot use --strict-mcp-config when an enterprise MCP config is present'
  for (const [agentId, args, exitCode, stderr, eligible] of [
    ['claude', ['--strict-mcp-config'], 1, canonical, true],
    [
      'claude',
      ['--strict-mcp-config'],
      1,
      'Failed reading enterprise MCP config; --strict-mcp-config was requested.',
      false
    ],
    ['claude', ['--strict-mcp-config'], 0, canonical, false],
    ['claude', ['--strict-mcp-config'], null, canonical, false],
    ['claude', ['--', '--strict-mcp-config'], 1, canonical, false],
    ['claude', ['--system-prompt', '--strict-mcp-config'], 1, canonical, false],
    ['codex', ['--strict-mcp-config'], 1, canonical, false]
  ] as const) {
    const result = { exitCode, stdout: '', stderr }
    const run = vi.fn(async () => result)
    expect(
      await runClaudeBackgroundAttempts({ agentId, args, run, failedExit: (outcome) => outcome })
    ).toBe(result)
    expect(run).toHaveBeenCalledTimes(eligible ? 2 : 1)
    if (eligible) {
      expect(run.mock.calls.at(-1)).toEqual([[]])
    }
  }
})
