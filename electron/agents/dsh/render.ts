/**
 * Pure ACP → terminal renderer.
 *
 * The DSH bridge runs inside a Hydra agent tile, which is an xterm.js pane:
 * everything the user sees has to be ANSI text. Keeping the translation pure
 * makes it unit-testable without spawning a real `dsh` process.
 */
import type { AcpContentBlock, AcpSessionUpdate } from './acpClient'

const RESET = '\u001b[0m'
const BOLD = '\u001b[1m'
const DIM = '\u001b[2m'
const RED = '\u001b[31m'
const GREEN = '\u001b[32m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'
const MAGENTA = '\u001b[35m'

/** Tool results can be enormous; keep tiles readable. */
const MAX_TOOL_OUTPUT_LINES = 12
const MAX_TOOL_OUTPUT_CHARS = 2000

export interface RenderState {
  /** messageId of the streaming message whose header was already printed. */
  openMessageId: string | null
  openMessageKind: 'assistant' | 'thought' | null
  /** toolCallId → human title, so updates can reference the original call. */
  toolTitles: Map<string, string>
}

export function createRenderState(): RenderState {
  return { openMessageId: null, openMessageKind: null, toolTitles: new Map() }
}

function color(code: string, text: string): string {
  return `${code}${text}${RESET}`
}

/** Close an in-progress streamed block so the next output starts cleanly. */
function closeOpenMessage(state: RenderState): string {
  if (!state.openMessageKind) return ''
  state.openMessageKind = null
  state.openMessageId = null
  return '\n'
}

export function textFromContentBlock(content: AcpContentBlock | undefined | null): string {
  if (!content || typeof content !== 'object') return ''
  if (typeof content.text === 'string') return content.text
  if (content.type === 'resource_link' && typeof content.uri === 'string') {
    return `<${String(content.uri)}>`
  }
  if (content.type === 'image') return '[image]'
  if (content.type === 'audio') return '[audio]'
  if (content.type === 'resource') return '[resource]'
  return ''
}

function truncateToolOutput(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  let result = trimmed
  if (result.length > MAX_TOOL_OUTPUT_CHARS) {
    result = `${result.slice(0, MAX_TOOL_OUTPUT_CHARS)}… (+${result.length - MAX_TOOL_OUTPUT_CHARS} chars)`
  }

  const lines = result.split('\n')
  if (lines.length > MAX_TOOL_OUTPUT_LINES) {
    const hidden = lines.length - MAX_TOOL_OUTPUT_LINES
    result = `${lines.slice(0, MAX_TOOL_OUTPUT_LINES).join('\n')}\n… (+${hidden} lines)`
  }

  return result
}

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function renderToolCallContent(content: unknown): string {
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const block = item as Record<string, unknown>

    if (block.type === 'content') {
      const text = truncateToolOutput(textFromContentBlock(block.content as AcpContentBlock))
      if (text) parts.push(indent(color(DIM, text)))
      continue
    }

    if (block.type === 'diff') {
      const path = typeof block.path === 'string' ? block.path : 'diff'
      parts.push(indent(color(DIM, `${path} (diff)`)))
      continue
    }

    if (block.type === 'terminal') {
      parts.push(indent(color(DIM, 'terminal output')))
    }
  }

  return parts.join('\n')
}

function renderToolStatus(status: unknown): string {
  switch (status) {
    case 'completed':
      return color(GREEN, '✓')
    case 'failed':
      return color(RED, '✗')
    case 'in_progress':
      return color(YELLOW, '◐')
    default:
      return color(DIM, '○')
  }
}

/**
 * Translate one `session/update` payload into terminal text.
 * Returns an empty string when the update is not worth showing.
 */
export function renderUpdate(state: RenderState, update: AcpSessionUpdate): string {
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''

  switch (kind) {
    case 'user_message_chunk': {
      const text = textFromContentBlock(update.content as AcpContentBlock)
      if (!text.trim()) return ''
      state.openMessageKind = null
      state.openMessageId = null
      return `${color(`${BOLD}${GREEN}`, '›')} ${text.trim()}\n`
    }

    case 'agent_message_chunk': {
      const text = textFromContentBlock(update.content as AcpContentBlock)
      if (!text) return ''
      const messageId = typeof update.messageId === 'string' ? update.messageId : null
      let header = ''
      if (state.openMessageKind !== 'assistant' || (messageId && state.openMessageId !== messageId)) {
        header = `${closeOpenMessage(state)}${color(`${BOLD}${CYAN}`, '● DSH')}\n`
        state.openMessageKind = 'assistant'
        state.openMessageId = messageId
      }
      return `${header}${text}`
    }

    case 'agent_thought_chunk': {
      const text = textFromContentBlock(update.content as AcpContentBlock)
      if (!text.trim()) return ''
      return `${closeOpenMessage(state)}${color(DIM, `… ${text.trim()}`)}\n`
    }

    case 'tool_call': {
      const toolCallId = String(update.toolCallId ?? '')
      const title = typeof update.title === 'string' && update.title.trim() ? update.title.trim() : 'tool call'
      if (toolCallId) state.toolTitles.set(toolCallId, title)
      const name = typeof update.name === 'string' && update.name ? ` ${color(DIM, `(${update.name})`)}` : ''
      const status = renderToolStatus(update.status ?? 'pending')
      const body = renderToolCallContent(update.content)
      return `${closeOpenMessage(state)}${status} ${color(MAGENTA, title)}${name}\n${body}${body ? '\n' : ''}`
    }

    case 'tool_call_update': {
      const toolCallId = String(update.toolCallId ?? '')
      const title =
        (typeof update.title === 'string' && update.title.trim() ? update.title.trim() : '') ||
        state.toolTitles.get(toolCallId) ||
        'tool call'
      const status = renderToolStatus(update.status)
      const body = renderToolCallContent(update.content)
      const failed = update.status === 'failed'
      const label = failed ? color(RED, title) : color(DIM, title)
      return `${closeOpenMessage(state)}${status} ${label}\n${body}${body ? '\n' : ''}`
    }

    case 'config_option_update': {
      const options = Array.isArray(update.configOptions) ? update.configOptions : []
      const parts: string[] = []
      for (const option of options) {
        if (!option || typeof option !== 'object') continue
        const record = option as Record<string, unknown>
        if (typeof record.id !== 'string') continue
        parts.push(`${record.id}=${formatConfigValue(record.currentValue)}`)
      }
      if (parts.length === 0) return ''
      return `${closeOpenMessage(state)}${color(DIM, `· config: ${parts.join(' ')}`)}\n`
    }

    case 'usage_update': {
      const used = typeof update.used === 'number' ? update.used : null
      const size = typeof update.size === 'number' ? update.size : null
      if (used === null) return ''
      const suffix = size ? ` / ${size}` : ''
      return `${closeOpenMessage(state)}${color(DIM, `· context: ${used}${suffix} tokens`)}\n`
    }

    case 'available_commands_update':
    case 'current_mode_update':
    case 'session_info_update':
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
      // Deliberately not rendered: the tile stays a transcript, not a dashboard.
      return ''

    default:
      return ''
  }
}

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed) && parsed.length === 2) return `${String(parsed[0])}/${String(parsed[1])}`
    } catch {
      /* not a JSON-encoded model route */
    }
    return value
  }
  if (value === null || value === undefined) return 'default'
  return String(value)
}

/** Startup banner: where we are, which model, and which session. */
export function renderBanner(info: {
  cwd: string
  model: string | null
  sessionId: string
  resumed: boolean
  agentName?: string | null
}): string {
  // Values are colourized as part of the whole line on purpose: Hydra reads the
  // raw PTY stream, so a style reset between the label and the value would hide
  // the session id from the provider's sessionIdRegex.
  const dim = (text: string): string => `${DIM}${text}${RESET}`
  const lines = [
    `${color(`${BOLD}${CYAN}`, 'DSH')} ${color(DIM, `via ACP${info.agentName ? ` · ${info.agentName}` : ''}`)}`,
    dim(`workspace: ${info.cwd}`),
    dim(`model:     ${info.model ?? 'provider default'}`),
    dim(`session:   ${info.sessionId} ${info.resumed ? '(resumed)' : ''}`.trimEnd()),
    dim('Type a prompt and press Enter. /help for commands.')
  ]
  return `${lines.join('\n')}\n`
}

/** Prompt echo for locally-handled input (Hydra also echoes, this is the tile's own). */
export function renderPrompt(text: string): string {
  return `\n${color(`${BOLD}${GREEN}`, '›')} ${text.trim()}\n`
}

export function renderTurnEnd(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'cancelled':
      return `${color(YELLOW, '■ cancelled')}\n`
    case 'refusal':
      return `${color(RED, '■ refused')}\n`
    case 'max_tokens':
      return `${color(YELLOW, '■ stopped: max tokens')}\n`
    case 'max_turn_requests':
      return `${color(YELLOW, '■ stopped: max turn requests')}\n`
    default:
      return ''
  }
}

export function renderPermissionPrompt(request: {
  title: string
  detail?: string
}): string {
  const lines = [
    `${color(`${BOLD}${YELLOW}`, '⚠ permission required')} ${request.title}`,
    request.detail ? color(DIM, indent(request.detail)) : '',
    `${color(DIM, 'Allow once? [y/N]')} `
  ].filter(Boolean)
  return `${lines.join('\n')}`
}

export function renderError(message: string): string {
  return `${color(RED, `✗ ${message}`)}\n`
}

export function renderInfo(message: string): string {
  return `${color(DIM, `· ${message}`)}\n`
}
