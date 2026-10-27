import type { NdjsonRejectedRecord } from '../../shared/main-process-ndjson-framer'
import type { ZcodeAppServerConnectionHandlers } from './zcode-app-server-connection-types'
import { isProviderRecord } from '../provider-process/provider-json-record'
import {
  ZcodeAppServerRequestError,
  ZcodeAppServerUnsupportedError
} from './zcode-app-server-session'
import { classifyJsonRpcPrefix } from '../../shared/json-rpc-record-prefix'

const OVERSIZED_REQUEST_ERROR_CODE = -32001
/** What the dispatcher answers when nobody handles a server request: ZCode
 *  documents -32601 as "client declines" for every interaction/* request —
 *  runtime preferences fall back to server defaults, MCP auth is skipped. */
const UNHANDLED_REQUEST_ERROR_CODE = -32601
const JSON_RPC_METHOD_NOT_FOUND = -32601
const MAX_REMEMBERED_TIMEOUTS = 64

function isZcodeMethodNotFoundCode(code: number): boolean {
  return code === JSON_RPC_METHOD_NOT_FOUND
}

export type ZcodePendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Called as the reply is read, or as the request times out, before anything awaits it: in
   *  stdout order with every notification read around it. */
  onReply?: () => void
}

export function createZcodeAppServerRecordDispatcher(input: {
  handlers: ZcodeAppServerConnectionHandlers
  writeResponse: (payload: Record<string, unknown>) => void
  onProtocolFailure: (error: Error) => void
}): {
  addPending: (id: number, waiter: ZcodePendingRequest) => void
  deletePending: (id: number) => void
  timeOutPending: (id: number) => void
  failPending: (error: Error) => void
  dispatch: (message: Record<string, unknown>) => void
  rejectOversized: (rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }) => void
} {
  const pending = new Map<number, ZcodePendingRequest>()
  const timedOutMethods = new Map<number, string>()

  const timeOutPending = (id: number): void => {
    const waiter = pending.get(id)
    if (!waiter) {
      return
    }
    pending.delete(id)
    waiter.onReply?.()
    timedOutMethods.set(id, waiter.method)
    const oldest = timedOutMethods.keys().next()
    if (timedOutMethods.size > MAX_REMEMBERED_TIMEOUTS && !oldest.done) {
      timedOutMethods.delete(oldest.value)
    }
  }

  const failPending = (error: Error): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  const dispatch = (message: Record<string, unknown>): void => {
    const hasMethod = typeof message.method === 'string'
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (hasMethod && hasId) {
      const request = {
        id: message.id as number | string,
        method: message.method as string,
        params: message.params
      }
      if (input.handlers.onServerRequest) {
        input.handlers.onServerRequest(request)
      } else {
        input.writeResponse({
          id: request.id,
          error: {
            code: UNHANDLED_REQUEST_ERROR_CODE,
            message: `Method not found: ${request.method}`
          }
        })
      }
      return
    }
    if (hasMethod) {
      input.handlers.onNotification?.(message.method as string, message.params)
      return
    }
    if (typeof message.id !== 'number') {
      input.handlers.onUnhandledFrame?.('frame:unclassified', message)
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) {
      const timedOutMethod = timedOutMethods.get(message.id)
      timedOutMethods.delete(message.id)
      const error = isProviderRecord(message.error) ? message.error.message : undefined
      console.warn(
        timedOutMethod
          ? `[zcode-app-server] late reply to ${timedOutMethod} after timeout (id ${message.id})`
          : `[zcode-app-server] reply with no waiting request (id ${message.id})`,
        ...(typeof error === 'string' ? [error] : [])
      )
      return
    }
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    waiter.onReply?.()
    const error = message.error
    if (isProviderRecord(error)) {
      const detail = typeof error.message === 'string' ? error.message : 'unknown error'
      waiter.reject(
        typeof error.code === 'number' && isZcodeMethodNotFoundCode(error.code)
          ? new ZcodeAppServerUnsupportedError(
              `zcode app-server does not support ${waiter.method}: ${detail}`
            )
          : new ZcodeAppServerRequestError(
              waiter.method,
              typeof error.code === 'number' ? error.code : null,
              `zcode app-server ${waiter.method} failed: ${detail}`,
              typeof error.message === 'string' ? error.message : undefined
            )
      )
      return
    }
    waiter.resolve(message.result)
  }

  const rejectOversized = (rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }): void => {
    const classification = classifyJsonRpcPrefix(rejected.prefix)
    const payload = {
      reason: 'record-too-large',
      observedBytes: rejected.observedBytes,
      maxBytes: rejected.maxLineBytes,
      classification: classification.kind,
      ...('id' in classification ? { id: classification.id } : {}),
      ...('method' in classification ? { method: classification.method } : {})
    }
    if (classification.kind === 'response') {
      const waiter = pending.get(classification.id)
      if (!waiter) {
        input.handlers.onUnhandledFrame?.('frame:oversized-response', payload)
        input.onProtocolFailure(
          new Error(
            `zcode app-server oversized response ${classification.id} had no pending request`
          )
        )
        return
      }
      pending.delete(classification.id)
      clearTimeout(waiter.timer)
      waiter.reject(
        new Error(`zcode app-server ${waiter.method} reply exceeded ${rejected.maxLineBytes} bytes`)
      )
      return
    }
    if (classification.kind === 'server-request') {
      input.writeResponse({
        id: classification.id,
        error: {
          code: OVERSIZED_REQUEST_ERROR_CODE,
          message: `request exceeds ${rejected.maxLineBytes} byte limit`
        }
      })
      input.handlers.onUnhandledFrame?.('frame:oversized-request', payload)
      return
    }
    if (classification.kind === 'notification') {
      input.handlers.onUnhandledFrame?.('frame:oversized-notification', payload)
      return
    }
    input.handlers.onUnhandledFrame?.('frame:oversized-unclassified', payload)
  }

  return {
    addPending: (id, waiter) => pending.set(id, waiter),
    deletePending: (id) => pending.delete(id),
    timeOutPending,
    failPending,
    dispatch,
    rejectOversized
  }
}
