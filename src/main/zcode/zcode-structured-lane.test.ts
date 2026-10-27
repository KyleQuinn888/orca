import { describe, expect, it } from 'vitest'

import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
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

  it('answers a permission card with the chosen protocol optionId, never a bare decision', () => {
    const subject = lane()
    // Plan approval: the server's options carry their own ids and pre-baked
    // responses; the card's option ids are those same ids, and the server
    // resolves the answer by looking the optionId up in its options.
    subject.permissionRequest(undefined as never, 44, {
      requestId: 'perm_plan1',
      toolCallId: 'call_plan',
      toolName: 'ExitPlanMode',
      options: [
        { optionId: 'allowOnce', kind: 'allow_once', name: 'Approve' },
        { optionId: 'deny', kind: 'deny', name: 'Deny' }
      ]
    })
    const pending = subject.pendingPrompts.get('44')!
    expect(pending.kind).toBe('approval')
    expect(pending.toolCallId).toBe('call_plan')
    expect(subject.answerFor(pending, { kind: 'option', optionId: 'allow_once' })).toEqual({
      decision: 'allow'
    })
    expect(subject.answerFor(pending, { kind: 'option', optionId: 'deny' })).toEqual({
      decision: 'deny'
    })
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

describe('ZcodeStructuredLane interrupted turns', () => {
  // A sink that accepts every write: the no-sink lane drops turn transitions,
  // and the settle under test rides an admitted turn.end.
  function acceptingEvents(): StructuredAgentSessionEventSink {
    return {
      tryAppendTransition: () => ({ accepted: true }),
      journalItems: () => null,
      setActivity: () => {}
    } as never as StructuredAgentSessionEventSink
  }

  function armedLane(settled: string[]): ZcodeStructuredLane {
    const l = new ZcodeStructuredLane((s) => settled.push(s.clientMessageId), {
      events: acceptingEvents(),
      sessionId: 'zcode_s1',
      generation: 'g1',
      providerSessionId: 'sess_provider_1'
    })
    l.inputAccepted('send-1', 1)
    l.notification('session/event', { type: 'turn.started', turnId: 'turn-1', seq: 1, timestamp: 1 })
    return l
  }

  it('settles the armed turn when the accepted stop arrives without a wire terminal', () => {
    const settled: string[] = []
    const l = armedLane(settled)
    expect(l.armedTurnIdentity()).not.toBeNull()
    l.interruptArmedTurn()
    expect(settled).toEqual(['send-1'])
    // The settled identity stays available for the send reply still in flight.
    expect(l.armedTurnIdentity()).toEqual({
      provider: 'orca',
      clientMessageId: 'send-1'
    })
    // A second stop settles nothing further.
    l.interruptArmedTurn()
    expect(settled).toEqual(['send-1'])
  })

  it('is a no-op with nothing armed: an idle stop settles no dispatch', () => {
    const settled: string[] = []
    const l = new ZcodeStructuredLane((s) => settled.push(s.clientMessageId), {
      events: undefined,
      sessionId: 'zcode_s1',
      generation: 'g1',
      providerSessionId: 'sess_provider_1'
    })
    l.interruptArmedTurn()
    expect(settled).toEqual([])
  })
})
