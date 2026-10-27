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

  it('keeps every text segment of a multi-segment turn, closing the earlier one', () => {
    const translator = new ZcodeTimelineTranslator()
    const events = [
      // Segment one streams, then a tool call intervenes under a NEW id.
      ...translator.translate({
        type: 'model.streaming',
        turnId: 'turn_m',
        timestamp: 1,
        payload: { assistantMessageId: 'msg_a', delta: 'first ', kind: 'text_delta' }
      }),
      ...translator.translate({
        type: 'model.streaming',
        turnId: 'turn_m',
        timestamp: 2,
        payload: { assistantMessageId: 'msg_a', delta: 'segment', kind: 'text_delta' }
      }),
      ...translator.translate({
        type: 'model.streaming',
        turnId: 'turn_m',
        timestamp: 3,
        payload: { assistantMessageId: 'msg_b', delta: 'second segment', kind: 'text_delta' }
      }),
      ...translator.translate({
        type: 'turn.completed',
        turnId: 'turn_m',
        timestamp: 4,
        payload: { response: 'second segment', resultType: 'success', duration: 1 }
      })
    ].flat()
    const closed = events.filter((event) => event.type === 'text.close')
    expect(
      closed.some(
        (event) => event.type === 'text.close' && (event.item as { id: string }).id === 'msg_a'
      )
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'text.delta' &&
          (event.item as { id: string }).id === 'msg_a' &&
          event.text.includes('segment')
      )
    ).toBe(true)
    expect(
      events.some(
        (event) => event.type === 'text.delta' && (event.item as { id: string }).id === 'msg_b'
      )
    ).toBe(true)
  })

  it('renders an AskUserQuestion request as grouped question options, not the flat fallback', () => {
    const translator = new ZcodeTimelineTranslator()
    const events = translator.translate({
      type: 'userInput.requested',
      turnId: 'turn_x',
      timestamp: 5,
      // Shape as the app-server sends it: prompt is generic, questions carry
      // the real content, and entries have no id of their own.
      payload: {
        requestId: 'perm_uuid-1',
        sessionId: 'sess_1',
        toolCallId: 'call_1',
        toolName: 'AskUserQuestion',
        prompt: 'Tool AskUserQuestion requires user interaction',
        questions: [
          {
            question: '你希望我接下来做什么？',
            header: '下一步',
            multiSelect: false,
            options: [
              { value: '写一个小 demo', label: '写一个小 demo', description: '创建一个示例项目' },
              { value: '查看仓库结构', label: '查看仓库结构' }
            ]
          }
        ]
      }
    })
    expect(events).toEqual([
      {
        type: 'request.open',
        request: 'perm_uuid-1',
        join: { turn: 'turn_x' },
        body: {
          kind: 'question',
          question: 'Tool AskUserQuestion requires user interaction',
          questions: [
            {
              id: 'q0',
              question: '你希望我接下来做什么？',
              multiSelect: false,
              options: [
                { id: '写一个小 demo', label: '写一个小 demo', description: '创建一个示例项目' },
                { id: '查看仓库结构', label: '查看仓库结构' }
              ]
            }
          ],
          options: [
            { id: '写一个小 demo', label: '写一个小 demo', description: '创建一个示例项目' },
            { id: '查看仓库结构', label: '查看仓库结构' }
          ],
          freeTextQuestionId: 'q0',
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
