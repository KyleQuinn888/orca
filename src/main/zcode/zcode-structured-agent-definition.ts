import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'

export const ZCODE_STRUCTURED_HANDLE_NAMESPACE = {
  transport: 'zcode-app-server',
  agent: 'zcode'
} as const

/** `ZCODE_STORAGE_DIR` redirects the whole storage root (sessions db, settings,
 *  plugins) that defaults to `~/.zcode`, so each Orca account home is one
 *  fully separate ZCode state directory. */
export const ZCODE_ACCOUNT_HOME_VARIABLE = 'ZCODE_STORAGE_DIR'

export function zcodeProviderHandle(sessionId: string): {
  transport: 'zcode-app-server'
  agent: 'zcode'
  nativeId: string
} {
  return { ...ZCODE_STRUCTURED_HANDLE_NAMESPACE, nativeId: sessionId }
}

/** Session options a ZCode structured session takes: model, effort and its
 *  permission mode (`session/setModel`, `session/setThoughtLevel`,
 *  `session/setMode` behind them). */
const ZCODE_OPTION_KEYS: ReadonlySet<string> = new Set(['model', 'effort', 'mode'])

export function isZcodeStructuredOptionKey(key: string): boolean {
  return ZCODE_OPTION_KEYS.has(key)
}

export const ZCODE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'zcode',
  handleTransport: ZCODE_STRUCTURED_HANDLE_NAMESPACE.transport,
  accountHomeVariable: ZCODE_ACCOUNT_HOME_VARIABLE,
  capabilities: {
    // Checkpoint rewind exists on the protocol (`session/fork` over
    // `checkpoint.created`) but is not wired yet; the declaration can widen
    // once the adapter implements it.
    rewind: false,
    compact: true,
    threadGoal: false,
    contextUsage: true,
    imagePrompts: true,
    // session/send answers -32010 while a turn runs; the host queues behind it.
    steering: 'queue',
    // Approvals ride on interaction/requestPermission; the server enforces.
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: isZcodeStructuredOptionKey,
    // Models come from the session snapshot's runtime block, not a CLI list.
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}
