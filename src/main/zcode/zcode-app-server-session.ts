// Error classes shared by every `zcode app-server` consumer, mirroring the
// codex app-server session errors. ZCode's wire errors reuse the JSON-RPC codes
// (-32601 method not found, -32010 busy, -32022 timed out).

import { providerDiagnostic, type ProviderDiagnostic } from '../../shared/agent-session-failure'

/** ZCode-side absence of the requested app-server surface (old CLI, or a server
 *  without the called method). The only error class capability caches mark
 *  unsupported; ZCode answers missing methods with JSON-RPC -32601. */
export class ZcodeAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerUnsupportedError'
  }
}

export class ZcodeAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerTimeoutError'
  }
}

/** ZCode answered the call and refused it, rather than timing out or exiting. */
export class ZcodeAppServerRequestError extends Error {
  /** ZCode's own `error.message`, kept apart from the Orca text around it. */
  readonly providerDiagnostic?: ProviderDiagnostic

  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    providerMessage?: string
  ) {
    super(message)
    this.name = 'ZcodeAppServerRequestError'
    const diagnostic =
      providerMessage === undefined ? undefined : providerDiagnostic(providerMessage, 'person')
    if (diagnostic) {
      this.providerDiagnostic = diagnostic
    }
  }
}

export function isZcodeAppServerRequestError(error: unknown): error is ZcodeAppServerRequestError {
  return error instanceof Error && error.name === 'ZcodeAppServerRequestError'
}

export type ZcodeAppServerRpc = {
  /** `timeoutMs` bounds one call, so a caller can drop it and go on. */
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
}
