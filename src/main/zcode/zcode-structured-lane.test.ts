import { describe, expect, it } from 'vitest'

import { ZcodeStructuredLane } from './zcode-structured-lane'

/** A lane with no journal behind it: enough to drive the held-prompt paths. */
function lane(): ZcodeStructuredLane {
  return new ZcodeStructuredLane(undefined, {
    events: undefined,
    sessionId: 'zcode_s1',
    generation: 'g1',
    providerSessionId: 'sess_provider_1'
  })
}

// Shape as the app-server sends it for an AskUserQuestion tool call.
const ASK_PARAMS = {
  requestId: 'perm_uuid-1',
  sessionId: 'sess_provider_1',
  toolCallId: 'call_1',
  toolName: 'AskUserQuestion',
  prompt: 'Tool AskUserQuestion requires user interaction',
  questions: [
    {
      question: '你希望我接下来做什么？',
      header: '下一步',
      multiSelect: false,
      options: [
        { value: '写一个小 demo', label: '写一个小 demo' },
        { value: '查看仓库结构', label: '查看仓库结构' }
      ]
    }
  ]
}

describe('ZcodeStructuredLane held prompts', () => {
  it('answers an AskUserQuestion with accept plus an answers record keyed by question text', () => {
    const subject = lane()
    subject.userInputRequest(41, ASK_PARAMS)
    const pending = subject.pendingPrompts.get('41')
    expect(pending?.kind).toBe('question')
    expect(pending?.questions?.[0]?.question).toBe('你希望我接下来做什么？')
    expect(
      subject.answerFor(pending!, {
        kind: 'answers',
        answers: [{ questionId: 'q0', optionIds: ['写一个小 demo'] }]
      })
    ).toEqual({
      action: 'accept',
      content: { answers: { '你希望我接下来做什么？': '写一个小 demo' } }
    })
  })

  it('keeps Other free text as the answer value and declines when nothing is chosen', () => {
    const subject = lane()
    subject.userInputRequest(42, ASK_PARAMS)
    const pending = subject.pendingPrompts.get('42')!
    expect(
      subject.answerFor(pending, {
        kind: 'answers',
        answers: [{ questionId: 'q0', optionIds: [], other: '随便来一个' }]
      })
    ).toEqual({
      action: 'accept',
      content: { answers: { '你希望我接下来做什么？': '随便来一个' } }
    })
    expect(
      subject.answerFor(pending, {
        kind: 'answers',
        answers: [{ questionId: 'q0', optionIds: [] }]
      })
    ).toEqual({ action: 'decline' })
  })

  it('still answers the flat no-questions card by declining', () => {
    const subject = lane()
    subject.userInputRequest(43, {
      requestId: 'perm_uuid-2',
      prompt: 'Tool AskUserQuestion requires user interaction'
    })
    const pending = subject.pendingPrompts.get('43')!
    expect(pending.questions).toBeUndefined()
    expect(subject.answerFor(pending, { kind: 'option', optionId: 'answer' })).toEqual({
      action: 'decline'
    })
  })
})
