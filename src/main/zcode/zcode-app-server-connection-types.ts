export type ZcodeAppServerServerRequest = {
  id: number | string
  method: string
  params: unknown
}

export type ZcodeAppServerConnectionHandlers = {
  onNotification?: (method: string, params: unknown) => void
  /** A server→client request. Unlike codex, ZCode fails its own request (code
   *  -32022, 15s default) when the client never answers, and that failure
   *  aborts what asked for it — so the dispatcher answers -32601 whenever no
   *  handler is set, which the server treats as "client declines". */
  onServerRequest?: (request: ZcodeAppServerServerRequest) => void
  onUnhandledFrame?: (kind: string, payload: unknown) => void
  /** The root process exited, reported once. `expected`: a close had begun, so it is that close's
   *  end, even one that gave up first and came back unproven. */
  onExit?: (error: Error, exit?: { expected: boolean }) => void
  /** Awaited once the child has a pid and before the connection is returned; a rejection reaps the child. */
  onSpawned?: (pid: number) => Promise<void>
  /** Any stdout or stderr chunk from the child. */
  onOutput?: () => void
}

export type ZcodeAppServerConnection = {
  readonly pid: number | undefined
  readonly closed: boolean
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; onReply?: () => void }
  ) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
  respond: (id: number | string, result: unknown) => void
  respondWithError: (id: number | string, code: number, message: string) => void
  /** Stops provider stdout at a record boundary while a durable sink drains. */
  pauseReading?: () => void
  /** Continues with any records retained from the chunk that triggered the pause. */
  resumeReading?: () => void
  /** Resolves true only after the child emitted `exit` or `close`; false is unproven. */
  close: () => Promise<boolean>
  /** The root exited, but the forced kill of its process tree could not prove the tree gone. */
  readonly processTreeUnproven?: boolean
}
