import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { admitTranscriptPath } from './transcript-path-admission'
import {
  absoluteConversationStore,
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory,
  type StructuredAgentTranscriptImport
} from './structured-agent-cli-conversations'

/** How zcode chats own their Session History rows and adopt CLI-recorded ones. */
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

/**
 * The CLI's single conversation store: the sqlite database under the storage
 * dir (`ZCODE_STORAGE_DIR`, default `~/.zcode`). Both TUI and app-server
 * children record into it, and the sqlite transcript reader and the ai-vault
 * scanner already parse its session/message/part schema.
 */
function zcodeConversationDatabase(launchEnv: NodeJS.ProcessEnv): string | null {
  const storageDir = launchEnv.ZCODE_STORAGE_DIR?.trim() || join(homedir(), '.zcode')
  return absoluteConversationStore(join(storageDir, 'cli', 'db', 'db.sqlite'))
}

/** The transcript is a row in the store's own database, so both are that file. */
export const ZCODE_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  // One legacy account home: the storage dir the chat's environment pins.
  accountHomeCandidates: ({ selectedAccountHome }) => [selectedAccountHome],
  conversationStore: ({ launchEnv }) => zcodeConversationDatabase(launchEnv),
  admitTranscriptPath: async ({ store: dbPath, transcriptPath }) => {
    const [expected, actual] = await Promise.all([
      admitTranscriptPath(dirname(dbPath), dbPath),
      admitTranscriptPath(dirname(dbPath), transcriptPath)
    ])
    return expected && actual && expected.path === actual.path ? actual.path : null
  },
  findTranscript: async ({ providerSessionId, store: dbPath }) => {
    try {
      if (!(await stat(dbPath)).isFile()) {
        return null
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return null
      }
      throw error
    }
    const { readOpenCodeTranscriptSignalViaWorker } =
      await import('../ai-vault/session-scanner-opencode-sqlite-worker-spawn')
    const signal = await readOpenCodeTranscriptSignalViaWorker({
      dbPath,
      sessionId: providerSessionId,
      agent: 'zcode'
    })
    return signal ? dbPath : null
  }
}
