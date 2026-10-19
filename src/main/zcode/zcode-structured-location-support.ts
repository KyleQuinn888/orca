import { isNativeLocalLocation } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'

export function supportsZcodeStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return isNativeLocalLocation(location)
}
