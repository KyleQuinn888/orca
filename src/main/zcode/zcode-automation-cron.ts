function fieldMatches(field: string, value: number, low: number): boolean {
  if (field === '*') {
    return true
  }
  for (const part of field.split(',')) {
    const step = part.includes('/') ? Number(part.split('/')[1]) : 1
    const range = part.includes('/') ? part.split('/')[0] : part
    if (step < 1) {
      continue
    }
    if (range === '*') {
      if ((value - low) % step === 0) {
        return true
      }
      continue
    }
    const bits = range.split('-').map(Number)
    if (bits.some((bit) => !Number.isInteger(bit))) {
      continue
    }
    const from = bits.length === 2 ? bits[0]! : bits[0]!
    const to = bits.length === 2 ? bits[1]! : bits[0]!
    if (value >= from && value <= to && (value - from) % step === 0) {
      return true
    }
  }
  return false
}

export function cronMatches(expr: string, at: Date): boolean {
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/)
  if (!minute || !hour || !dom || !month || !dow) {
    return false
  }
  if (
    !fieldMatches(minute, at.getUTCMinutes(), 0) ||
    !fieldMatches(hour, at.getUTCHours(), 0) ||
    !fieldMatches(dom, at.getUTCDate(), 1) ||
    !fieldMatches(month, at.getUTCMonth() + 1, 1)
  ) {
    return false
  }
  const anyDayConstraint = dom !== '*' || dow !== '*'
  if (!anyDayConstraint) {
    return true
  }
  // Cron's day fields are a union: dom OR dow (dow 0 and 7 both name Sunday).
  const domHit = dom !== '*' && fieldMatches(dom, at.getUTCDate(), 1)
  const dowHit = dow !== '*' && fieldMatches(dow.replace(/7/g, '0'), at.getUTCDay(), 0)
  return domHit || dowHit
}
