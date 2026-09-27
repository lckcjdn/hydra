/**
 * A dependency-free Agent Client Protocol (ACP) client.
 *
 * DSH exposes its agents through `dsh --profile acp`: a JSON-RPC 2.0 server
 * that speaks newline-delimited JSON on stdio. Hydra drives that server from
 * the DSH bridge process (see ./bridge.ts), which in turn runs inside the
 * normal agent tile PTY.
 *
 * Only the surface Hydra needs is modelled here; everything is typed loosely
 * on purpose so a newer DSH that adds fields does not break parsing.
 */
import { EventEmitter } from 'events'

/** JSON-RPC method names used by the DSH ACP server. */
export const ACP_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionList: 'session/list',
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetConfigOption: 'session/set_config_option',
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission'
} as const

/** ACP content block as sent in prompts and received in updates. */
export interface AcpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface AcpAgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
  mcpCapabilities?: { http?: boolean; sse?: boolean }
  sessionCapabilities?: {
    list?: Record<string, unknown>
    resume?: Record<string, unknown>
    close?: Record<string, unknown>
    delete?: Record<string, unknown>
  }
  [key: string]: unknown
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string; title?: string }
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: unknown[]
}

export interface AcpConfigOptionValue {
  value: string
  name: string
  description?: string
}

export interface AcpConfigOption {
  id: string
  name?: string
  category?: string
  type?: string
  currentValue?: unknown
  options?: Array<AcpConfigOptionValue | { group?: string; name?: string; options?: AcpConfigOptionValue[] }>
  [key: string]: unknown
}

export interface AcpSessionUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

export interface AcpSessionNotification {
  sessionId: string
  update: AcpSessionUpdate
}

export interface AcpPermissionRequest {
  sessionId: string
  toolCall?: { toolCallId?: string; title?: string; kind?: string; [key: string]: unknown }
  options?: Array<{ optionId: string; name?: string; kind?: string }>
  [key: string]: unknown
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

export interface AcpSessionListEntry {
  sessionId: string
  cwd?: string
}

export interface AcpSessionListResult {
  sessions: AcpSessionListEntry[]
  nextCursor?: string
}

export interface AcpPromptResult {
  stopReason?: string
  [key: string]: unknown
}

export class AcpRequestError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown
  ) {
    super(`${method} failed${code === undefined ? '' : ` (${code})`}: ${message}`)
    this.name = 'AcpRequestError'
  }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export interface AcpTransport {
  /** Send one already-serialized protocol line (no trailing newline). */
  write(line: string): void
  /** Register the line handler. */
  onLine(handler: (line: string) => void): void
  /** Register the close handler. */
  onClose(handler: (error?: Error) => void): void
  /** Terminate the underlying process/stream. */
  close(): void
}

export interface AcpClientOptions {
  /** Default per-request timeout; `session/prompt` always uses `promptTimeoutMs`. */
  requestTimeoutMs?: number
  /** Prompt turns can legitimately run for many minutes. */
  promptTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_PROMPT_TIMEOUT_MS = 0 // 0 = no timeout

interface OutgoingMessage {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: unknown
}

interface IncomingMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

/**
 * Client half of an ACP connection. Emits:
 *  - `notification` ({ method, params }) for server notifications.
 *  - `request` ({ method, params }) for server-initiated requests; the listener
 *    must call {@link AcpClient.respondWithResult} or
 *    {@link AcpClient.respondWithError}.
 *  - `closed` (Error | undefined) once the transport goes away.
 */
export class AcpClient extends EventEmitter {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private closed = false

  constructor(
    private readonly transport: AcpTransport,
    private readonly options: AcpClientOptions = {}
  ) {
    super()
    this.transport.onLine((line) => this.handleLine(line))
    this.transport.onClose((error) => this.handleClose(error))
  }

  get isClosed(): boolean {
    return this.closed
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`ACP connection is closed (${method})`))
    }

    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          : null

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.settlePending(id, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  respondWithResult(id: number | string, result: unknown): void {
    this.sendRaw({ jsonrpc: '2.0', id, result })
  }

  respondWithError(id: number | string, code: number, message: string, data?: unknown): void {
    this.sendRaw({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  /** Reject every in-flight request and stop the transport. */
  close(reason?: string): void {
    // Mark closed first so a transport-triggered close cannot replace the
    // caller's reason with the generic "connection closed" message.
    const error = reason ? new Error(reason) : undefined
    this.handleClose(error)
    this.transport.close()
  }

  // ── Typed conveniences ────────────────────────────────────────────────────

  initialize(clientInfo: { name: string; version: string }): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>(
      ACP_METHODS.initialize,
      {
        // ACP protocol version 1 is what the shipped DSH ACP server implements.
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo
      },
      // DSH resolves the configured model's capabilities during initialize,
      // which can hit a slow/rate-limited provider catalog, so allow a while.
      { timeoutMs: 90_000 }
    )
  }

  newSession(cwd: string): Promise<{ sessionId: string; configOptions?: AcpConfigOption[] }> {
    return this.request(ACP_METHODS.sessionNew, { cwd, mcpServers: [] }, { timeoutMs: 60_000 })
  }

  resumeSession(
    sessionId: string,
    cwd: string
  ): Promise<{ configOptions?: AcpConfigOption[] }> {
    return this.request(
      ACP_METHODS.sessionResume,
      { sessionId, cwd, mcpServers: [] },
      { timeoutMs: 60_000 }
    )
  }

  listSessions(cwd?: string): Promise<AcpSessionListResult> {
    return this.request<AcpSessionListResult>(
      ACP_METHODS.sessionList,
      cwd ? { cwd } : {},
      { timeoutMs: 30_000 }
    )
  }

  closeSession(sessionId: string): Promise<unknown> {
    return this.request(ACP_METHODS.sessionClose, { sessionId }, { timeoutMs: 30_000 })
  }

  prompt(sessionId: string, prompt: AcpContentBlock[]): Promise<AcpPromptResult> {
    return this.request<AcpPromptResult>(
      ACP_METHODS.sessionPrompt,
      { sessionId, prompt },
      { timeoutMs: this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS }
    )
  }

  cancel(sessionId: string): void {
    this.notify(ACP_METHODS.sessionCancel, { sessionId })
  }

  setConfigOption(
    sessionId: string,
    configId: string,
    value: unknown
  ): Promise<{ configOptions?: AcpConfigOption[] }> {
    return this.request(
      ACP_METHODS.sessionSetConfigOption,
      { sessionId, configId, value },
      { timeoutMs: 30_000 }
    )
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private send(message: OutgoingMessage): void {
    this.sendRaw(message)
  }

  private sendRaw(message: unknown): void {
    this.transport.write(JSON.stringify(message))
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let message: IncomingMessage
    try {
      message = JSON.parse(trimmed) as IncomingMessage
    } catch {
      this.emit('protocol-error', new Error(`Unparseable ACP line: ${trimmed.slice(0, 200)}`))
      return
    }

    const isResponse = message.id !== undefined && message.method === undefined
    if (isResponse) {
      this.handleResponse(message)
      return
    }

    if (typeof message.method !== 'string') return

    if (message.id !== undefined) {
      // Server-initiated request (e.g. session/request_permission).
      this.emit('request', { id: message.id, method: message.method, params: message.params })
      return
    }

    this.emit('notification', { method: message.method, params: message.params })
  }

  private handleResponse(message: IncomingMessage): void {
    const id = typeof message.id === 'number' ? message.id : Number(message.id)
    const pending = this.pending.get(id)
    if (!pending) return

    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)

    if (message.error) {
      pending.reject(
        new AcpRequestError(
          pending.method,
          message.error.code,
          message.error.message ?? 'unknown ACP error',
          message.error.data
        )
      )
      return
    }

    pending.resolve(message.result)
  }

  private handleClose(error?: Error): void {
    if (this.closed) return
    this.closed = true

    for (const [id] of this.pending) {
      this.settlePending(id, error ?? new Error('ACP connection closed'))
    }

    this.emit('closed', error)
  }

  private settlePending(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.reject(error)
  }
}
