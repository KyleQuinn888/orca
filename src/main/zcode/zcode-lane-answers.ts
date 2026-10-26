// The protocol answer for one held interaction request, built from what the
// person chose on its card. Lives beside the lane: pure, and the lane's line
// budget is tight.

import type { ZcodeHeldPrompt } from './zcode-structured-lane'

export function zcodeLaneAnswerFor(
  pending: ZcodeHeldPrompt,
  response:
    | { kind: 'option'; optionId: string }
    | { kind: 'answers'; answers: { questionId: string; optionIds: string[]; other?: string }[] }
): Record<string, unknown> {
  if (pending.kind === 'approval') {
    // The wire result schema is strict: {decision, reason?}. The card's
    // deny option (and only it) is a denial; allow_once, allow_project and
    // approvals of every other name all read as allow.
    return {
      decision: response.kind === 'option' && response.optionId === 'deny' ? 'deny' : 'allow'
    }
  }
  if (response.kind !== 'answers') {
    return { action: 'decline' }
  }
  // The server merges content.answers keyed by the question TEXT (it derives
  // those keys from the tool input); synthesized card ids map back by order.
  const answers: Record<string, string> = {}
  response.answers.forEach((answer, index) => {
    const question = pending.questions?.[index]?.question
    if (question === undefined) {
      return
    }
    const value = answer.other ?? answer.optionIds.join(', ')
    if (value.length > 0) {
      answers[question] = value
    }
  })
  if (Object.keys(answers).length === 0) {
    return { action: 'decline' }
  }
  return { action: 'accept', content: { answers } }
}
