import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'

// Recorded from a real `zcode app-server` 0.16.9 turn (yolo mode, one Bash tool
// call, Chinese reply); the payload shapes are ground truth, not constructed.
const RECORDED_TURN = readFileSync(
  join(import.meta.dirname, '__fixtures__/zcode-tool-turn.jsonl'),
  'utf8'
)
  .split('\n')
  .filter(Boolean)
  .map(
    (line) =>
      JSON.parse(line) as {
        type: string
        payload: Record<string, unknown>
        turnId?: string
        timestamp?: number
      }
  )

describe('ZcodeTimelineTranslator', () => {
  it('replays the recorded tool turn as a complete timeline', () => {
    const translator = new ZcodeTimelineTranslator()
    const events: ProviderTimelineEvent[] = []
    for (const envelope of RECORDED_TURN) {
      events.push(...translator.translate(envelope))
    }

    // The turn opened with the provider's own id.
    expect(events[0]).toMatchObject({ type: 'turn.open', turn: expect.stringMatching(/^turn_/) })

    // Reasoning and reply streamed under their assistant message ids.
    const textDeltas = events.filter((event) => event.type === 'text.delta')
    expect(
      textDeltas.some((event) => event.type === 'text.delta' && event.channel === 'reasoning')
    ).toBe(true)
    const replyDeltas = textDeltas.filter(
      (event) => event.type === 'text.delta' && 'id' in event.item && event.channel === 'assistant'
    )
    expect(replyDeltas.length).toBeGreaterThan(0)

    // The Bash call opened running and closed completed with its streamed input
    // and recorded output.
    const toolOpens = events.filter(
      (event) => event.type === 'item.open' && event.body.kind === 'tool-call'
    )
    expect(toolOpens).toHaveLength(1)
    expect(toolOpens[0]).toMatchObject({
      item: expect.stringMatching(/^call_/),
      body: { name: 'Bash', state: 'running' }
    })
    const toolClose = events.find(
      (event) => event.type === 'item.close' && event.body.kind === 'tool-call'
    )
    expect(toolClose).toMatchObject({
      body: {
        name: 'Bash',
        state: 'completed',
        input: { command: 'echo hello-protocol' }
      }
    })
    if (toolClose?.type === 'item.close' && toolClose.body.kind === 'tool-call') {
      expect(toolClose.body.output?.head).toContain('hello-protocol')
    }

    // turn.completed closes the streamed reply with the provider's own final
    // text, then ends the turn with its verdict.
    const textClose = events.find((event) => event.type === 'text.close')
    expect(textClose).toMatchObject({ text: expect.stringContaining('hello-protocol') })
    const turnEnd = events.at(-1)
    expect(turnEnd).toMatchObject({
      type: 'turn.end',
      state: 'completed',
      outcome: 'success',
      durationMs: expect.any(Number)
    })
  })

  it('translates the same envelope identically on retry', () => {
    const translator = new ZcodeTimelineTranslator()
    const envelope = RECORDED_TURN.find((record) => record.type === 'model.streaming')
    const once = translator.translate(envelope!)
    const twice = translator.translate(envelope!)
    expect(twice).toEqual(once)
  })

  it('drops the hook-descriptor noise the stream carries', () => {
    const translator = new ZcodeTimelineTranslator()
    const dropped: string[] = []
    const noisy = new ZcodeTimelineTranslator((reason) => dropped.push(reason))
    const hooks = RECORDED_TURN.filter((record) => record.type === 'session.updated')
    expect(hooks.length).toBeGreaterThan(0)
    for (const record of hooks) {
      expect(noisy.translate(record)).toEqual([])
    }
    expect(dropped.length).toBe(hooks.length)
    void translator
  })

  it('maps a permission request to a pending approval with its own options', () => {
    const translator = new ZcodeTimelineTranslator()
    const events = translator.translate({
      type: 'permission.requested',
      turnId: 'turn_x',
      timestamp: 5,
      payload: {
        requestId: 'perm-1',
        toolName: 'Bash',
        riskLevel: 'medium',
        reason: 'runs a command',
        options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }]
      }
    })
    expect(events).toEqual([
      {
        type: 'request.open',
        request: 'perm-1',
        join: { turn: 'turn_x' },
        body: {
          kind: 'approval',
          title: 'runs a command',
          detail: 'runs a command',
          options: [{ id: 'allow-once', label: 'Allow' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }
    ])
  })
})
