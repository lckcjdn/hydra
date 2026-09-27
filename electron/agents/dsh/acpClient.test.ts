import { describe, expect, it, vi } from 'vitest'
import { AcpClient, AcpRequestError, type AcpTransport } from './acpClient'

/** In-memory transport: records outgoing lines and lets tests push replies. */
class FakeTransport implements AcpTransport {
  readonly written: string[] = []
  closed = false
  private lineHandler: (line: string) => void = () => undefined
  private closeHandler: (error?: Error) => void = () => undefined

  write(line: string): void {
    this.written.push(line)
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler
  }

  close(): void {
    this.closed = true
    this.closeHandler()
  }

  /** Simulate a server → client message. */
  receive(message: unknown): void {
    this.lineHandler(typeof message === 'string' ? message : JSON.stringify(message))
  }

  /** Simulate the underlying process dying. */
  die(error?: Error): void {
    this.closeHandler(error)
  }

  sent(): Array<Record<string, unknown>> {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

function setup(): { transport: FakeTransport; client: AcpClient } {
  const transport = new FakeTransport()
  const client = new AcpClient(transport, { requestTimeoutMs: 1000 })
  return { transport, client }
}

describe('AcpClient', () => {
  it('frames requests as newline-delimited JSON-RPC and resolves by id', async () => {
    const { transport, client } = setup()

    const pending = client.request('session/list', { cwd: 'D:\\Projects\\hydra' })
    expect(transport.written).toHaveLength(1)
    expect(transport.written[0].endsWith('\n')).toBe(false)
    // The transport adds the newline; the payload itself must be one JSON object.
    expect(JSON.parse(transport.written[0])).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/list',
      params: { cwd: 'D:\\Projects\\hydra' }
    })

    transport.receive({ jsonrpc: '2.0', id: 1, result: { sessions: [{ sessionId: 'abc', cwd: 'x' }] } })
    await expect(pending).resolves.toEqual({ sessions: [{ sessionId: 'abc', cwd: 'x' }] })
  })

  it('maps JSON-RPC errors onto AcpRequestError with the server message', async () => {
    const { transport, client } = setup()

    const pending = client.request('session/prompt', { sessionId: 's' })
    transport.receive({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'a prompt is already in flight for this session' }
    })

    await expect(pending).rejects.toBeInstanceOf(AcpRequestError)
    await expect(pending).rejects.toThrow('a prompt is already in flight for this session')
  })

  it('emits notifications and answers server requests', () => {
    const { transport, client } = setup()
    const notifications: unknown[] = []
    const requests: Array<{ id: number | string; method: string; params?: unknown }> = []

    client.on('notification', (message: unknown) => notifications.push(message))
    client.on('request', (message: { id: number | string; method: string; params?: unknown }) => {
      requests.push(message)
      client.respondWithResult(message.id, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
    })

    transport.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } }
    })
    transport.receive({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: { sessionId: 's', toolCall: { toolCallId: 'call_1' } }
    })

    expect(notifications).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(JSON.parse(transport.written[0])).toEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
  })

  it('sends notifications without an id', () => {
    const { transport, client } = setup()
    client.cancel('session-1')

    expect(JSON.parse(transport.written[0])).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'session-1' }
    })
  })

  it('ignores malformed lines without dropping the connection', () => {
    const { transport, client } = setup()
    const errors: Error[] = []
    client.on('protocol-error', (error: Error) => errors.push(error))

    transport.receive('not json at all')
    expect(errors).toHaveLength(1)

    const pending = client.request('initialize', {})
    transport.receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    return expect(pending).resolves.toMatchObject({ protocolVersion: 1 })
  })

  it('rejects in-flight requests and emits closed when the transport dies', async () => {
    const { transport, client } = setup()
    const closed = vi.fn()
    client.on('closed', closed)

    const pending = client.request('session/new', { cwd: 'x', mcpServers: [] })
    transport.die(new Error('dsh exited'))

    await expect(pending).rejects.toThrow('dsh exited')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(client.isClosed).toBe(true)
    await expect(client.request('session/list', {})).rejects.toThrow('closed')
  })

  it('times out a request that never gets a response', async () => {
    vi.useFakeTimers()
    try {
      const { client } = setup()
      const pending = client.request('session/list', {}, { timeoutMs: 50 })
      const assertion = expect(pending).rejects.toThrow('session/list timed out after 50ms')
      await vi.advanceTimersByTimeAsync(60)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects every pending request on an explicit close', async () => {
    const { client } = setup()
    const pending = client.request('session/prompt', { sessionId: 's' }, { timeoutMs: 5000 })
    client.close('shutting down')
    await expect(pending).rejects.toThrow('shutting down')
  })
})
