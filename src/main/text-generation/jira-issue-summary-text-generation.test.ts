import { describe, expect, it } from 'vitest'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { generateCommitMessage } from './source-control-text-generation-requests'
import type {
  CommitMessageGenerationTarget,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'
import { getAgentModelProbeSpec } from '../../shared/agent-model-probe-spec'
import { planModelDiscovery } from './commit-message-model-discovery-policy'
import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { generateJiraIssueSummaryFromContext } from './jira-issue-summary-text-generation'

function remoteTarget(execute: (plan: CommitMessagePlan) => Promise<string>) {
  return {
    kind: 'remote' as const,
    cwd: '/home/user',
    missingBinaryLocation: 'remote PATH',
    execute: async (plan: CommitMessagePlan) => ({
      stdout: await execute(plan),
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
  }
}

describe('generateJiraIssueSummaryFromContext', () => {
  it('sanitizes agent output into a single-line summary', async () => {
    const result = await generateJiraIssueSummaryFromContext(
      { description: 'Login crashes when retried offline.' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      remoteTarget(async () => '"Fix offline login retry crash"\nextra commentary')
    )

    expect(result).toEqual({
      success: true,
      summary: 'Fix offline login retry crash',
      agentLabel: 'agent'
    })
  })

  it('sends its own Jira prompt and ignores source-control templates and instructions', async () => {
    let prompt = ''
    await generateJiraIssueSummaryFromContext(
      {
        description: 'Crash on save',
        projectName: 'Mobile App',
        issueTypeName: 'Bug'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        customPrompt: 'Prefer kebab-case names.',
        commandInputTemplate: 'Prefer kebab-case names.\n\n{basePrompt}'
      },
      remoteTarget(async (plan) => {
        prompt = plan.stdinPayload ?? ''
        return 'Fix crash on save'
      })
    )

    expect(prompt).toContain('Generate a concise Jira issue summary')
    expect(prompt).toContain('Project: <project>Mobile App</project>')
    expect(prompt).toContain('Issue type: <issue_type>Bug</issue_type>')
    expect(prompt).toContain('Crash on save')
    expect(prompt).not.toContain('kebab-case')
  })

  it('fails when the output sanitizes to an empty summary', async () => {
    const result = await generateJiraIssueSummaryFromContext(
      { description: 'Crash on save' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      remoteTarget(async () => '""\n')
    )

    expect(result).toEqual({
      success: false,
      error: 'Generated summary was empty after sanitization.'
    })
  })

  it('propagates agent failures', async () => {
    const result = await generateJiraIssueSummaryFromContext(
      { description: 'Crash on save' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/home/user',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'No API key found.',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'agent CLI command failed with code 1: No API key found.'
    })
  })
})

// One owner must cover Jira and ordinary generation through both existing transports.
it.each(['local', 'remote'] as const)(
  'retries the same Claude invocation for Jira and commits on %s',
  async (kind) => {
    for (const operation of ['jira-issue-summary', 'commit-message'] as const) {
      const calls: { args: string[]; other: unknown }[] = []
      const response = (args: string[]) => {
        const refused = args.includes('--strict-mcp-config')
        return {
          stdout: refused ? '' : 'Fix crash',
          stderr: refused
            ? 'You cannot use --strict-mcp-config when an enterprise MCP config is present'
            : '',
          exitCode: refused ? 1 : 0,
          timedOut: false
        }
      }
      const spawnAgent: SpawnSourceControlAgent = ({ args, ...other }) => {
        calls.push({ args, other })
        const child = Object.assign(new ChildProcess(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough()
        })
        queueMicrotask(() => {
          const output = response(args)
          child.stdout.emit('data', Buffer.from(output.stdout))
          child.stderr.emit('data', Buffer.from(output.stderr))
          child.emit('close', output.exitCode)
        })
        return child
      }
      const target: CommitMessageGenerationTarget =
        kind === 'local'
          ? { kind, cwd: '/repo' }
          : {
              kind,
              cwd: '/repo',
              missingBinaryLocation: 'remote PATH',
              execute: async ({ args, ...other }, cwd, timeout, op) => {
                expect(op).toBe(operation)
                calls.push({ args, other: { ...other, cwd, timeout, op } })
                return response(args)
              }
            }
      const params = { agentId: 'claude' as const, model: 'haiku' }
      const result =
        operation === 'jira-issue-summary'
          ? await generateJiraIssueSummaryFromContext(
              { description: 'Crash on save' },
              params,
              target,
              spawnAgent
            )
          : await generateCommitMessage({
              context: { stagedSummary: 'M file', stagedPatch: '+fix' },
              params,
              target,
              spawnAgent
            })
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual({
        ...calls[0],
        args: calls[0].args.filter((arg) => arg !== '--strict-mcp-config')
      })
    }
  }
)

it('preserves Jira custom output and OpenCode one-attempt behavior', async () => {
  expect(
    await generateJiraIssueSummaryFromContext(
      { description: 'Crash' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      remoteTarget(async () => 'Draft thought</think>\nFix crash')
    )
  ).toMatchObject({ summary: 'Draft thought</think>' })
  let attempts = 0
  const result = await generateJiraIssueSummaryFromContext(
    { description: 'Crash' },
    { agentId: 'opencode', model: 'provider/model', thinkingLevel: 'high' },
    {
      kind: 'remote',
      cwd: '/repo',
      missingBinaryLocation: 'remote PATH',
      execute: async () => {
        attempts++
        return { stdout: '', stderr: 'Unknown argument: variant', exitCode: 1, timedOut: false }
      }
    }
  )
  expect(result.success).toBe(false)
  expect(attempts).toBe(1)
})

it.each([
  ['', '', '{"disableAllHooks":true}'],
  [
    '--settings \'{"language":"French"}\'',
    '--settings \'{"model":"haiku"}\'',
    '{"disableAllHooks":true,"model":"haiku"}'
  ],
  [
    '--settings earlier.json',
    '--settings=\'{"model":"haiku"}\'',
    '{"disableAllHooks":true,"model":"haiku"}'
  ],
  ['--settings \'{"language":"French"}\'', '--settings winning.json', 'winning.json'],
  [
    '',
    '--settings=\'{"disableAllHooks":false}\' --mcp-config explicit.json',
    '{"disableAllHooks":false}'
  ]
])(
  'preserves effective settings across discovery and preview: %s %s',
  (prefix, recipe, effective) => {
    const preview = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'haiku',
        agentCommandOverride: `claude ${prefix}`,
        agentArgs: recipe
      },
      'prompt'
    )
    const spec = getAgentModelProbeSpec('claude')
    if (!spec) {
      throw new Error('Missing Claude spec')
    }
    const discovery = planModelDiscovery(spec, `claude ${prefix} ${recipe}`)
    for (const planned of [preview, discovery]) {
      if (!planned.ok) {
        throw new Error(planned.error)
      }
      const options = planned.plan.args.filter(
        (arg) => arg === '--settings' || arg.startsWith('--settings=')
      )
      const last = options.at(-1) ?? ''
      const value =
        last === '--settings'
          ? planned.plan.args[planned.plan.args.lastIndexOf(last) + 1]
          : last.slice(11)
      expect(value).toBe(effective)
      expect(planned.plan.args.join(' ')).toContain(prefix.replaceAll("'", ''))
      expect(planned.plan.args.includes('explicit.json')).toBe(recipe.includes('explicit.json'))
    }
  }
)
