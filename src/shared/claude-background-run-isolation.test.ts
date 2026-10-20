import { expect, it } from 'vitest'
import { isolateClaudeBackgroundArgs } from './claude-background-run-isolation'

// Claude keeps only the last --settings, so a user's inline settings join Orca's in one value.
it("merges a user's inline --settings into the one value Claude keeps", () => {
  expect(
    isolateClaudeBackgroundArgs(['-p', '--settings', '{"includeCoAuthoredBy":false}'])
  ).toEqual([
    '-p',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true,"includeCoAuthoredBy":false}'
  ])
})
