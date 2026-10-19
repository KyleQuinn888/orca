import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from './structured-agent-cli-conversations'

/** How zcode chats own their Session History rows; `transcriptImport` stays null
 *  until adoption of CLI-recorded sessions lands (session/list over app-server). */
export const ZCODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['zcode'],
  // A zcode handle's nativeId is the provider session id Session History rows list.
  rowSessionId: (link) => link.handle.nativeId,
  // `-c/--continue` resumes the latest session for the folder; `--resume <id>` that id.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['--resume']
    })
}
