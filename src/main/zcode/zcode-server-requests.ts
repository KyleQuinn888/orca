import type { ZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeStructuredLane } from './zcode-structured-lane'
import type { ZcodeAutomationStore } from './zcode-automation-store'
import { answerZcodeAutomationRequest } from './zcode-automation-answers'
import { answerZcodeBrowserWireRequest, type ZcodeBrowserBackend } from './zcode-browser-backend'

/** What routing a server request needs from one live zcode session. */
export type ZcodeServerRequestSession = {
  reportedOptions: Record<string, string>
  lane: ZcodeStructuredLane
}

export type ZcodeServerRequestDeps = {
  automation: ZcodeAutomationStore
  browser?: ZcodeBrowserBackend
}

/**
 * Server requests: interaction requests journal through the lane; browser-use
 * drives the Orca backend; everything else declines with -32601, which the
 * ZCode Protocol documents as the client refusing (runtime preferences fall
 * back to defaults).
 */
export function routeZcodeServerRequest(
  session: ZcodeServerRequestSession,
  sessionId: string,
  request: { id: number | string; method: string; params: unknown },
  connection: ZcodeAppServerConnection,
  deps: ZcodeServerRequestDeps
): void {
  if (request.method === 'interaction/requestPermission') {
    // Full access (protocol yolo) auto-allows: a card would only race the
    // server's request timeout and die as "handled elsewhere".
    if (session.reportedOptions.mode === 'yolo') {
      // The wire result schema is strict {decision}; allow is the approval.
      connection.respond(request.id, { decision: 'allow' })
      return
    }
    session.lane.permissionRequest(connection, request.id, request.params)
    return
  }
  if (request.method === 'interaction/requestUserInput') {
    session.lane.userInputRequest(request.id, request.params)
    return
  }
  // Browser-use reverse requests: routed to the Orca backend when the host
  // lent one, else discovery answers an honest empty list.
  if (
    request.method === 'interaction/browserList' ||
    request.method === 'interaction/browserExecute'
  ) {
    answerZcodeBrowserWireRequest(deps.browser, request, connection)
    return
  }
  if (request.method.startsWith('automation/')) {
    answerZcodeAutomationRequest(deps.automation, sessionId, request, connection)
    return
  }
  connection.respondWithError(request.id, -32601, `Method not found: ${request.method}`)
}
