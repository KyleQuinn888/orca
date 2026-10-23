import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ZcodeSession } from './zcode-structured-session-adapter'
import { readZcodeLiveOptions } from './zcode-structured-options'

/** The whole handshake finished inside acquire, so open answers at once with
 *  the live child's reported options; the host settles the start with them. */
export function zcodeProviderOpen(
  sessions: Map<string, ZcodeSession>
): StructuredAgentSessionAdapter['open'] {
  return (input) => {
    const session = sessions.get(input.sessionId)
    const usable =
      session && !session.ended && session.acquisitionGeneration === input.acquisitionGeneration
    return usable && session
      ? Promise.resolve({ reportedOptions: readZcodeLiveOptions(session).current })
      : Promise.reject(new Error(`no live zcode app-server session for ${input.sessionId}`))
  }
}
