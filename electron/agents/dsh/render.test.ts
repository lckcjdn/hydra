import { describe, expect, it } from 'vitest'
import { getProvider } from '../providers'
import {
  createRenderState,
  renderBanner,
  renderError,
  renderPermissionPrompt,
  renderTurnEnd,
  renderUpdate,
  textFromContentBlock
} from './render'

// Same fromCharCode trick as bridge.ts: no literal ESC for no-control-regex.
const strip = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

describe('renderUpdate', () => {
  it('renders committed assistant messages with a single header', () => {
    const state = createRenderState()

    const first = renderUpdate(state, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: 'Hello' }
    })
    expect(strip(first)).toContain('DSH')
    expect(strip(first)).toContain('Hello')

    // Same message: no repeated header.
    const second = renderUpdate(state, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: ' world' }
    })
    expect(strip(second)).toBe(' world')

    // New message: header again.
    const third = renderUpdate(state, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-2',
      content: { type: 'text', text: 'Next' }
    })
    expect(strip(third)).toContain('DSH')
  })

  it('renders thoughts, tool calls, tool results, and usage', () => {
    const state = createRenderState()

    expect(strip(renderUpdate(state, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'considering options' }
    }))).toContain('considering options')

    const call = renderUpdate(state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'pwsh',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'npm test' }
    })
    expect(strip(call)).toContain('pwsh')
    expect(strip(call)).toContain('◐')

    const result = renderUpdate(state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'all tests passed' } }]
    })
    expect(strip(result)).toContain('all tests passed')
    expect(strip(result)).toContain('✓')

    const failed = renderUpdate(state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'failed'
    })
    expect(strip(failed)).toContain('✗')

    expect(strip(renderUpdate(state, { sessionUpdate: 'usage_update', used: 1234, size: 131072 }))).toContain(
      '1234'
    )
  })

  it('summarises model config updates as readable routes', () => {
    const state = createRenderState()
    const text = renderUpdate(state, {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']),
          options: []
        }
      ]
    })

    expect(strip(text)).toContain('deepseek-official/deepseek-v4-flash')
  })

  it('truncates very large tool output', () => {
    const state = createRenderState()
    const text = strip(
      renderUpdate(state, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_big',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') }
          }
        ]
      })
    )

    expect(text).toContain('line 0')
    expect(text).toContain('lines)')
    expect(text).not.toContain('line 39')
  })

  it('ignores update kinds Hydra does not surface', () => {
    const state = createRenderState()
    expect(renderUpdate(state, { sessionUpdate: 'plan', entries: [] })).toBe('')
    expect(renderUpdate(state, { sessionUpdate: 'available_commands_update', availableCommands: [] })).toBe('')
  })
})

describe('renderBanner', () => {
  it('announces the session id in a form the provider regex captures', () => {
    const sessionId = '01d247fb-b4e2-4de8-9934-7a354a928a9e'
    const banner = renderBanner({
      cwd: 'D:\\Projects\\hydra',
      model: 'deepseek-official/deepseek-v4-flash',
      sessionId,
      resumed: false
    })

    expect(strip(banner)).toContain(`session:   ${sessionId}`)
    // The provider regex runs against the raw PTY stream, so the banner must keep
    // the label and the id in one unbroken span. This pins that invariant.
    const providerRegex = getProvider('dsh').sessionIdRegex
    expect(providerRegex).not.toBeNull()
    expect(banner.match(providerRegex!)?.[1]).toBe(sessionId)
  })
})

describe('terminal helpers', () => {
  it('renders turn endings, permission prompts, and errors', () => {
    expect(strip(renderTurnEnd('cancelled'))).toContain('cancelled')
    expect(strip(renderTurnEnd('end_turn'))).toBe('')
    expect(strip(renderPermissionPrompt({ title: 'pwsh' }))).toContain('pwsh')
    expect(strip(renderPermissionPrompt({ title: 'pwsh' }))).toContain('[y/N]')
    expect(strip(renderError('boom'))).toContain('boom')
  })

  it('extracts text from content blocks', () => {
    expect(textFromContentBlock({ type: 'text', text: 'hi' })).toBe('hi')
    expect(textFromContentBlock({ type: 'image', data: 'x', mimeType: 'image/png' })).toBe('[image]')
    expect(textFromContentBlock(null)).toBe('')
  })
})
