import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { ZcodeAppServerTimeoutError } from './zcode-app-server-session'
import { createZcodeAppServerRecordDispatcher } from './zcode-app-server-record-dispatch'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers
} from './zcode-app-server-connection-types'

export type {
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers,
  ZcodeAppServerServerRequest
} from './zcode-app-server-connection-types'
export {
  ZcodeAppServerRequestError,
  isZcodeAppServerRequestError
} from './zcode-app-server-session'
export { ROOT_ONLY_GRACEFUL_EXIT_MS as GRACEFUL_EXIT_MS } from '../provider-process/provider-process-close'

// Structured chat needs a persistent bidirectional child and per-request
// deadlines. Unlike codex, the ZCode Protocol has no initialize handshake: the
// server is usable the moment it spawns (it announces storage progress through
// `startup/storageState` notifications), so openZcodeAppServerConnection
// returns as soon as the child exists.

export type ZcodeAppServerLaunch = ProviderProcessLaunch

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Spawns `zcode app-server` and returns a connection that stays open until
 * `close()`. Rejects — after reaping the child — when the child never starts.
 */
export async function openZcodeAppServerConnection(
  launch: ZcodeAppServerLaunch,
  handlers: ZcodeAppServerConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess
): Promise<ZcodeAppServerConnection> {
  const managed = spawnManagedProviderProcess(launch, {
    spawnImpl,
    site: 'zcode-app-server-teardown',
    ...(handlers.onOutput ? { onOutput: handlers.onOutput } : {})
  })
  const { child, terminateTree: terminateProcessTree } = managed

  let nextRequestId = 1
  let closing = false
  let exitReported = false
  /** First terminal cause, or null while the transport is still usable. Set once:
   *  a child that dies reaches us through several listeners, and the specific
   *  first cause is the one worth reporting. */
  let terminalError: Error | null = null

  function buildExitError(cause?: Error): Error {
    const tail = managed.stderrTail().trim().slice(0, 400)
    const detail = cause ? `: ${cause.message}` : tail ? `: ${tail}` : ''
    const error = new Error(`zcode app-server connection ended${detail}`)
    return managed.executableMissing ? withMissingProviderExecutable(error) : error
  }

  const dispatcher = createZcodeAppServerRecordDispatcher({
    handlers,
    writeResponse,
    onProtocolFailure: (error) => {
      handleUnexpectedEnd(error)
      void terminateProcessTree()
    }
  })

  /** A death nobody asked for kills every in-flight call AND tells the owner,
   *  which is the only signal the session has that its lease is now worthless.
   *  Once only: a fatal handler failure kills the child before `close` arrives,
   *  and a spawn failure arrives as both `error` and `close`. */
  function handleUnexpectedEnd(cause?: Error): void {
    if (!terminalError) {
      terminalError = buildExitError(cause)
      dispatcher.failPending(terminalError)
    }
    // Transport/protocol failures make the connection unusable immediately so
    // callers do not hang, but recovery must not treat that as a child exit
    // until the execution host has observed `exit`/`close`.
    if (managed.rootVerdict === 'exited' && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError, { expected: closing })
    }
  }

  child.on('error', (error) => {
    handleUnexpectedEnd(error)
  })
  managed.onExit(() => handleUnexpectedEnd())
  child.stdin.on('error', (error) => {
    if (closing) {
      dispatcher.failPending(error)
      return
    }
    handleUnexpectedEnd(error)
    void terminateProcessTree()
  })

  const recordReader = createProviderRecordReader({
    stdout: child.stdout,
    onRecord: (parsed, line) => {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        handlers.onUnhandledFrame?.('frame:invalid-json', line)
        return
      }
      dispatcher.dispatch(parsed as Record<string, unknown>)
    },
    onRejected: (rejected) => {
      if (rejected.kind === 'invalid-json') {
        handlers.onUnhandledFrame?.('frame:invalid-json', rejected.line)
      } else {
        dispatcher.rejectOversized(rejected)
      }
    },
    onFatal: (error) => {
      handleUnexpectedEnd(error)
      void terminateProcessTree()
    }
  })

  function sendLine(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    if (managed.rootVerdict === 'exited' || terminalError) {
      return
    }
    try {
      sendLine(params === undefined ? { method } : { method, params })
    } catch {
      // Fire-and-forget; the next request surfaces a dead child.
    }
  }

  function request(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number; onReply?: () => void } = {}
  ): Promise<unknown> {
    if (closing) {
      return Promise.reject(new Error(`zcode app-server connection is closed (${method})`))
    }
    if (terminalError) {
      return Promise.reject(terminalError)
    }
    if (managed.rootVerdict === 'exited') {
      return Promise.reject(buildExitError())
    }
    const id = nextRequestId++
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<unknown>((resolve, reject) => {
      // Why: per request, not per session — a chat session outlives every call,
      // so only the individual call can carry a deadline.
      const timer = setTimeout(() => {
        dispatcher.timeOutPending(id)
        reject(new ZcodeAppServerTimeoutError(`zcode app-server ${method} exceeded ${timeoutMs}ms`))
      }, timeoutMs)
      dispatcher.addPending(id, { method, resolve, reject, timer, onReply: options.onReply })
      try {
        sendLine(params === undefined ? { method, id } : { method, id, params })
      } catch (error) {
        dispatcher.deletePending(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function writeResponse(payload: Record<string, unknown>): void {
    if (
      managed.rootVerdict === 'exited' ||
      terminalError ||
      child.stdin.destroyed ||
      !child.stdin.writable
    ) {
      return
    }
    try {
      sendLine(payload)
    } catch {
      // The turn that asked is already gone with the child.
    }
  }

  function close(): Promise<boolean> {
    closing ||= managed.rootVerdict !== 'exited'
    return managed.close().then((result) => {
      dispatcher.failPending(new Error('zcode app-server connection closed'))
      return result.root === 'exited'
    })
  }

  const connection: ZcodeAppServerConnection = {
    get pid() {
      return child.pid
    },
    get closed() {
      return closing || managed.rootVerdict === 'exited' || terminalError !== null
    },
    get processTreeUnproven() {
      const tree = managed.lastCloseResult?.tree
      return (
        managed.lastCloseResult?.root === 'exited' && (tree === 'unverifiable' || tree === 'live')
      )
    },
    request,
    notify,
    respond: (id, result) => writeResponse({ id, result }),
    respondWithError: (id, code, message) => writeResponse({ id, error: { code, message } }),
    pauseReading: recordReader.pause,
    resumeReading: recordReader.resume,
    close
  }

  // No initialize handshake exists in the ZCode Protocol; the connection is
  // live once the child has a pid. A spawn that failed has none, and the exit
  // listeners above report why.
  if (child.pid !== undefined) {
    try {
      await handlers.onSpawned?.(child.pid)
    } catch (error) {
      if ((await close()) !== true) {
        throw error
      }
      throw buildExitError(error instanceof Error ? error : new Error(String(error)))
    }
  } else if (managed.rootVerdict === 'exited' || terminalError) {
    if ((await close()) !== true) {
      throw terminalError ?? buildExitError()
    }
    throw buildExitError()
  }
  return connection
}
