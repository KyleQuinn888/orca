// The zcode protocol's grouped-question shape mapped to the journal's card
// schema: every grouped question needs multiSelect and {id,label} options, or
// the journal's write-time validation rejects the whole card row.

type JournalOption = { id: string; label: string; description?: string }
export type ZcodeJournalQuestion = {
  id: string
  question: string
  multiSelect: boolean
  options: JournalOption[]
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function mapZcodeProtocolQuestions(rawQuestions: unknown): ZcodeJournalQuestion[] {
  if (!Array.isArray(rawQuestions)) {
    return []
  }
  const mapped: ZcodeJournalQuestion[] = []
  for (const raw of rawQuestions) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }
    const entry = raw as Record<string, unknown>
    // The protocol identifies questions by their text (the runtime's answer
    // merge keys answers by it); entries carry no id, so one is minted here
    // and answerFor maps it back through the same order.
    const id = asString(entry.id) ?? asString(entry.questionId) ?? `q${mapped.length}`
    const question = asString(entry.question) ?? asString(entry.header) ?? ''
    if (question.length === 0) {
      continue
    }
    const options: JournalOption[] = []
    for (const option of Array.isArray(entry.options) ? entry.options : []) {
      if (typeof option !== 'object' || option === null) {
        continue
      }
      const opt = option as Record<string, unknown>
      const label = asString(opt.label) ?? asString(opt.value) ?? ''
      const optionId = asString(opt.id) ?? (label.length > 0 ? label : null)
      if (optionId === null) {
        continue
      }
      options.push({
        id: optionId,
        label: label.length > 0 ? label : optionId,
        ...(asString(opt.description) !== null
          ? { description: asString(opt.description) ?? '' }
          : {})
      })
    }
    if (options.length === 0) {
      continue
    }
    mapped.push({ id, question, multiSelect: entry.multiSelect === true, options })
  }
  return mapped
}
