import { describe, expect, it } from 'bun:test'
import type { ParsedRow } from './journal-row-parse'
import { emptyState, migrateState, isActive, isTerminal, metricsOf, setPolicy } from './roadmap-store'
import { crossesThreshold, filePathOfInput, foldRowsIntoMetrics, isFileEditRow, isUserTurnRow } from './session-threshold'

const msg = (role: string): ParsedRow => ({ kind: 'item', body: { kind: 'message', role } }) as ParsedRow
const tool = (name: string, input: unknown): ParsedRow => ({ kind: 'item', body: { kind: 'tool-call', name, input } }) as ParsedRow

describe('store v2', () => {
  it('v1 migration: optedIn become eligible', () => {
    const v1 = { version: 1 as const, optedIn: ['s1'], sessions: {} }
    const s = migrateState(v1)
    expect(s.version).toBe(2)
    expect(s.policy['s1']).toBe('eligible')
    expect(s.policy['s2']).toBe(undefined)
    expect(isActive(s, 's1')).toBe(true)
    expect(isTerminal(s, 's1')).toBe(false)
  })

  it('terminal states override; unset is candidate', () => {
    const s = emptyState()
    setPolicy(s, 'a', 'deleted')
    setPolicy(s, 'b', 'excluded')
    expect(isTerminal(s, 'a') && isTerminal(s, 'b')).toBe(true)
    expect(isActive(s, 'a')).toBe(false)
    expect(isActive(s, 'c')).toBe(false)
    expect(isTerminal(s, 'c')).toBe(false)
  })
})

describe('threshold', () => {
  it('turns / edits / distinct files criteria', () => {
    const m = metricsOf(emptyState(), 's')
    foldRowsIntoMetrics(m, [msg('user'), msg('assistant'), msg('user')])
    expect(m.turns).toBe(2)
    expect(crossesThreshold(m)).toBe(false)
    foldRowsIntoMetrics(m, Array.from({ length: 9 }, () => msg('user')))
    expect(crossesThreshold(m)).toBe(true) // 11 turns >= 10
  })

  it('file edits: distinct paths count; 3 distinct files crosses', () => {
    const m = metricsOf(emptyState(), 's')
    foldRowsIntoMetrics(m, [
      tool('Edit', { file_path: 'a.ts' }),
      tool('Edit', { file_path: 'a.ts' }),
      tool('Write', { file_path: 'b.ts' }),
      tool('str_replace_editor', { target_file: 'c.ts' })
    ])
    expect(m.edits).toBe(4)
    expect(m.fileCount).toBe(4)
    expect(JSON.stringify(m.files)).toBe(JSON.stringify(['a.ts', 'b.ts', 'c.ts']))
    expect(crossesThreshold(m)).toBe(true)
  })

  it('row predicates', () => {
    expect(isUserTurnRow(msg('user'))).toBe(true)
    expect(isUserTurnRow(msg('assistant'))).toBe(false)
    expect(isFileEditRow(tool('Edit', { file_path: 'x' }))).toBe(true)
    expect(isFileEditRow(tool('Bash', { command: 'ls' }))).toBe(false)
    expect(isFileEditRow(tool('Read', { file_path: 'x' }))).toBe(false)
    expect(filePathOfInput({ filePath: 'y' })).toBe('y')
    expect(filePathOfInput(null)).toBe(null)
  })
})
