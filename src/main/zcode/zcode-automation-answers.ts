// The automation/* wire answers, apart from the adapter so each file keeps
// its size budget: the validated record shape out, the request in.

import type { ZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeAutomationStore, ZcodeAutomationRecord } from './zcode-automation-store'

function wireRecord(record: ZcodeAutomationRecord): Record<string, unknown> {
  return {
    automationId: record.automationId,
    title: record.title,
    cronExpr: record.cronExpr,
    prompt: record.prompt,
    ...(record.modelSelection !== undefined ? { modelSelection: record.modelSelection } : {}),
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    ...(record.targetTaskId !== undefined ? { targetTaskId: record.targetTaskId } : {}),
    enabled: record.enabled,
    lifecycleStatus: record.lifecycleStatus,
    ...(record.nextRunAt !== undefined
      ? { nextRunAt: new Date(record.nextRunAt).toISOString() }
      : {}),
    ...(record.lastRunAt !== undefined
      ? { lastRunAt: new Date(record.lastRunAt).toISOString() }
      : {}),
    runCount: record.runCount,
    recurring: record.recurring,
    ...(record.maxRuns !== undefined ? { maxRuns: record.maxRuns } : {})
  }
}

/** One automation/* server request answered from the store. */
export function answerZcodeAutomationRequest(
  store: ZcodeAutomationStore,
  sessionId: string,
  request: { id: number | string; method: string; params: unknown },
  connection: ZcodeAppServerConnection
): void {
  const params = (request.params ?? {}) as Record<string, unknown>
  try {
    if (request.method === 'automation/create') {
      const record = store.create(
        {
          prompt: String(params.prompt ?? ''),
          title: String(params.title ?? 'Automation'),
          ...(typeof params.cronExpr === 'string' ? { cronExpr: params.cronExpr } : {}),
          ...(typeof params.relativeDelayMinutes === 'number'
            ? { relativeDelayMinutes: params.relativeDelayMinutes }
            : {}),
          ...(typeof params.intervalUnit === 'string' ? { intervalUnit: params.intervalUnit } : {}),
          ...(typeof params.interval === 'number' ? { interval: params.interval } : {}),
          ...(typeof params.recurring === 'boolean' ? { recurring: params.recurring } : {}),
          ...(typeof params.maxRuns === 'number' ? { maxRuns: params.maxRuns } : {}),
          ...(typeof params.targetTaskId === 'string' ? { targetTaskId: params.targetTaskId } : {})
        },
        sessionId
      )
      connection.respond(request.id, { automation: wireRecord(record) })
      return
    }
    if (request.method === 'automation/list') {
      connection.respond(request.id, { automations: store.list().map(wireRecord) })
      return
    }
    if (request.method === 'automation/update') {
      const updated = store.update(String(params.automationId ?? ''), {
        ...(typeof params.title === 'string' ? { title: params.title } : {}),
        ...(typeof params.cronExpr === 'string' ? { cronExpr: params.cronExpr } : {}),
        ...(typeof params.prompt === 'string' ? { prompt: params.prompt } : {}),
        ...(typeof params.recurring === 'boolean' ? { recurring: params.recurring } : {}),
        ...(params.maxRuns === null || typeof params.maxRuns === 'number'
          ? { maxRuns: params.maxRuns as number | null }
          : {}),
        ...(typeof params.intervalUnit === 'string' ? { intervalUnit: params.intervalUnit } : {}),
        ...(typeof params.interval === 'number' ? { interval: params.interval } : {})
      })
      if (updated === null) {
        connection.respondWithError(request.id, -32001, 'automation not found')
        return
      }
      connection.respond(request.id, { automation: wireRecord(updated) })
      return
    }
    if (request.method === 'automation/delete') {
      connection.respond(request.id, { deleted: store.delete(String(params.automationId ?? '')) })
      return
    }
    if (request.method === 'automation/checkTaskBinding') {
      connection.respond(request.id, { bound: store.boundTo(String(params.targetTaskId ?? '')) })
      return
    }
    connection.respondWithError(request.id, -32601, `Method not found: ${request.method}`)
  } catch (error) {
    connection.respondWithError(
      request.id,
      -32001,
      error instanceof Error ? error.message : 'automation request failed'
    )
  }
}
