import { beforeEach, describe, expect, it, vi } from 'vitest'

const wsConstructor = vi.fn()

vi.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1
    readyState = MockWebSocket.OPEN

    constructor(address: string, options?: Record<string, unknown>) {
      wsConstructor(address, options)
    }

    on(): this {
      return this
    }

    close(): void {
      // no-op
    }
  }

  return { default: MockWebSocket }
})

import { DaemonClient } from './DaemonClient'

describe('DaemonClient websocket connection', () => {
  beforeEach(() => {
    wsConstructor.mockReset()
  })

  it('connects websocket to the daemon TCP port on localhost', () => {
    const client = new DaemonClient(4500)

    ;(client as any).connectWebSocket()

    expect(wsConstructor).toHaveBeenCalledTimes(1)
    expect(wsConstructor.mock.calls[0]?.[0]).toBe('ws://127.0.0.1:4500/ws')
  })
})
