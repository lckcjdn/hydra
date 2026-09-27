/**
 * DSH ACP bridge — the process Hydra runs inside a DSH agent tile.
 *
 * Hydra's agent tiles are PTYs rendered by xterm.js, so this bridge adapts the
 * DeepSeek Harness Agent Client Protocol server (`dsh --profile acp`, JSON-RPC
 * over stdio) to a terminal-shaped conversation:
 *
 *   Hydra PTY stdin  → line editor → `session/prompt`
 *   `session/update` → ANSI text    → Hydra PTY stdout
 *
 * It is launched as a normal Node script (see providers.ts), never imported.
 */
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { AcpClient, AcpRequestError, type AcpContentBlock, type AcpPermissionRequest, type AcpSessionUpdate, type AcpTransport } from './acpClient'
import {
  createRenderState,
  renderBanner,
  renderError,
  renderInfo,
  renderPermissionPrompt,
  renderPrompt,
  renderTurnEnd,
  renderUpdate,
  textFromContentBlock
} from './render'

const CLIENT_INFO = { name: 'hydra-dsh-bridge', version: '1.0.0' }
const DEFAULT_PROFILE = 'acp'
/** How long to wait for `dsh` to answer `initialize` before giving up. */
const STARTUP_TIMEOUT_MS = 120_000
/** Input typed before the session is ready is buffered; cap it. */
const MAX_QUEUED_PROMPTS = 20

const RESET = '\u001b[0m'
const CYAN = '\u001b[36m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
// Built via fromCharCode because ESLint's no-control-regex rule rejects a
// literal ESC in either a regex literal or a RegExp() string argument.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

/**
 * One-shot mode: Hydra's headless runs need a single answer on stdout, so all
 * chrome (banner, tool activity, errors) is redirected to stderr and only the
 * assistant text reaches stdout. Set once in main().
 */
let oneShot = false

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * ACP failures carry the server's own explanation in `error.data.details`.
 * Surfacing it turns an opaque "Internal error" into something actionable.
 */
function describeAcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (!(error instanceof AcpRequestError)) return message

  const details = (error.data as { details?: unknown } | undefined)?.details
  if (typeof details !== 'string' || !details.trim()) return message

  if (/active write handle/i.test(details)) {
    return [
      details,
      'Another DSH process (for example the DSH web app) still has this session open.',
      'Close the session there — or quit that DSH instance — and restart this agent.'
    ].join('\n')
  }

  return `${message} — ${details}`
}

interface BridgeArgs {
  resumeSessionId: string | null
  model: string | null
  reasoningEffort: string | null
  prompt: string | null
  yolo: boolean
  profile: string
  dshBin: string
}

/** Write chrome (banner, status, errors): stderr in one-shot mode. */
function write(text: string): void {
  if (!text) return
  if (oneShot) {
    const plain = stripAnsi(text)
    if (plain) process.stderr.write(plain)
    return
  }
  process.stdout.write(text)
}

/** Write answer text: always stdout. */
function writeAnswer(text: string): void {
  if (text) process.stdout.write(oneShot ? stripAnsi(text) : text)
}

function parseArgs(argv: string[]): BridgeArgs {
  const args: BridgeArgs = {
    resumeSessionId: null,
    model: null,
    reasoningEffort: null,
    prompt: null,
    yolo: false,
    profile: process.env.DSH_PROFILE?.trim() || DEFAULT_PROFILE,
    dshBin: process.env.DSH_BIN?.trim() || 'dsh'
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`Missing value for ${flag}`)
      return value
    }

    switch (flag) {
      case '--resume':
        args.resumeSessionId = next()
        break
      case '--model':
        args.model = next()
        break
      case '--reasoning-effort':
        args.reasoningEffort = next()
        break
      case '--prompt':
        args.prompt = next()
        break
      case '--profile':
        args.profile = next()
        break
      case '--dsh-bin':
        args.dshBin = next()
        break
      case '--yolo':
        args.yolo = true
        break
      default:
        // Ignore unknown flags so Hydra can add options without breaking older bridges.
        break
    }
  }

  return args
}

/** Spawn a CLI command, using cmd.exe on Windows to handle .cmd/.ps1 shims. */
function spawnCli(command: string, cliArgs: string[], options: Parameters<typeof spawn>[2]) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/c', command, ...cliArgs], options)
  }
  return spawn(command, cliArgs, options)
}

/** Spawn `dsh --profile acp` and expose its stdio as an {@link AcpTransport}. */
function spawnDshAcp(
  args: BridgeArgs,
  cwd: string,
  onStderr: (line: string) => void
): { transport: AcpTransport; describe: string } {
  const child = spawnCli(args.dshBin, ['--profile', args.profile], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  })

  let lineHandler: (line: string) => void = () => undefined
  let closeHandler: (error?: Error) => void = () => undefined
  let closed = false

  const finish = (error?: Error): void => {
    if (closed) return
    closed = true
    closeHandler(error)
  }

  const reader = createInterface({ input: child.stdout! })
  reader.on('line', (line) => lineHandler(line))

  child.stderr!.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const text = line.trim()
      if (text) onStderr(text)
    }
  })

  child.on('error', (error) => {
    finish(
      new Error(
        `Could not start the DSH CLI ("${args.dshBin}"). Install it with \`npm i -g @deepseek-ai/dsh\`, then restart this agent.\n${error.message}`
      )
    )
  })

  child.on('exit', (code, signal) => {
    reader.close()
    finish(new Error(`dsh --profile ${args.profile} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`))
  })

  const transport: AcpTransport = {
    write(line: string): void {
      if (closed || !child.stdin || child.stdin.destroyed) return
      child.stdin.write(`${line}\n`)
    },
    onLine(handler): void {
      lineHandler = handler
    },
    onClose(handler): void {
      closeHandler = handler
    },
    close(): void {
      try {
        child.stdin?.end()
      } catch {
        /* already gone */
      }
      // The CLI sits behind a cmd.exe shim on Windows, so a plain kill would
      // orphan it — and an orphaned ACP server keeps the session's write handle,
      // which makes that session impossible to resume later.
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            stdio: 'ignore',
            windowsHide: true
          })
            .on('error', () => undefined)
            .unref()
        } catch {
          /* best effort */
        }
      }
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }

  return { transport, describe: `${args.dshBin} --profile ${args.profile}` }
}

/**
 * Minimal raw-mode line editor: history, cursor movement, batching of redraws,
 * and a one-shot `ask()` mode used for permission prompts. Echoes through
 * stdout so the PTY shows exactly what the bridge understands.
 */
class LineEditor {
  private buffer = ''
  private cursor = 0
  private history: string[] = []
  private historyIndex = -1
  private pending: ((answer: string) => void) | null = null
  private enabled = true
  private started = false
  private promptText = `${CYAN}›${RESET} `

  constructor(
    private readonly onSubmit: (line: string) => void,
    private readonly onEof: () => void = () => undefined
  ) {}

  start(): void {
    this.started = true
    const stdin = process.stdin
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true)
    }
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => this.handleChunk(chunk))
    stdin.on('end', () => {
      // EOF is not always "quit": a piped caller may have queued a prompt that
      // still has to run. The owner decides when to shut down.
      this.enabled = false
      this.onEof()
    })
  }

  disable(): void {
    this.enabled = false
  }

  /** Repaint the input line; used after server output has been written. */
  refresh(): void {
    if (this.enabled && this.started) this.redraw()
  }

  ask(prompt: string): Promise<string> {
    this.promptText = prompt
    this.buffer = ''
    this.cursor = 0
    this.redraw()
    return new Promise<string>((resolve) => {
      this.pending = resolve
    })
  }

  private redraw(): void {
    const tail = this.buffer.slice(this.cursor)
    write(`\r\u001b[K${this.promptText}${this.buffer}`)
    if (tail.length > 0) write(`\u001b[${tail.length}D`)
  }

  private submit(): void {
    const line = this.buffer
    this.buffer = ''
    this.cursor = 0
    this.historyIndex = -1
    write('\r\u001b[K')

    if (this.pending) {
      const resolve = this.pending
      this.pending = null
      this.promptText = `${CYAN}›${RESET} `
      resolve(line.trim())
      return
    }

    if (line.trim()) this.history.push(line)
    this.onSubmit(line)
  }

  private handleChunk(chunk: string): void {
    if (!this.enabled) return

    // A chunk that is nothing but a line terminator is a real Enter press.
    if (chunk === '\n' || chunk === '\r' || chunk === '\r\n') {
      this.submit()
      return
    }

    let dirty = false

    const insert = (text: string): void => {
      this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor)
      this.cursor += text.length
      dirty = true
    }

    let i = 0
    while (i < chunk.length) {
      const char = chunk[i]

      // Escape sequences (arrows, home/end, delete).
      if (char === '\u001b' && chunk[i + 1] === '[') {
        const code = chunk[i + 2]
        i += 3
        switch (code) {
          case 'A':
            this.historyPrev()
            break
          case 'B':
            this.historyNext()
            break
          case 'C':
            if (this.cursor < this.buffer.length) this.cursor++
            break
          case 'D':
            if (this.cursor > 0) this.cursor--
            break
          case 'H':
            this.cursor = 0
            break
          case 'F':
            this.cursor = this.buffer.length
            break
          case '3':
            i++
            if (this.cursor < this.buffer.length) {
              this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1)
            }
            break
          default:
            break
        }
        dirty = true
        continue
      }

      i++

      if (char === '\r') {
        // CRLF arrives as one chunk from ConPTY; the LF is part of the same Enter.
        if (chunk[i] === '\n') i++
        this.submit()
        dirty = false
        continue
      }

      if (char === '\n') {
        // Inside a multi-line prompt (Hydra writes the text, then CR) LF is content.
        insert('\n')
        continue
      }

      if (char === '\u0003') {
        const hadText = this.buffer.length > 0
        this.buffer = ''
        this.cursor = 0
        dirty = false
        if (this.pending) {
          const resolve = this.pending
          this.pending = null
          this.promptText = `${CYAN}›${RESET} `
          write('\r\u001b[K')
          resolve('')
          continue
        }
        write(`\r\u001b[K${hadText ? renderInfo('cancelled') : ''}`)
        this.onSubmit('\u0003')
        continue
      }

      if (char === '\u0004') {
        write('\r\u001b[K')
        this.onSubmit('\u0004')
        dirty = false
        continue
      }

      if (char === '\u007f' || char === '\b') {
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor)
          this.cursor--
        }
        dirty = true
        continue
      }

      if (char === '\u0001') {
        this.cursor = 0
        dirty = true
        continue
      }

      if (char === '\u0005') {
        this.cursor = this.buffer.length
        dirty = true
        continue
      }

      if (char === '\u0015') {
        this.buffer = this.buffer.slice(this.cursor)
        this.cursor = 0
        dirty = true
        continue
      }

      if (char === '\u0017') {
        const head = this.buffer.slice(0, this.cursor)
        const trimmed = head.replace(/\S+\s*$/, '')
        this.buffer = trimmed + this.buffer.slice(this.cursor)
        this.cursor = trimmed.length
        dirty = true
        continue
      }

      // Ignore other control characters; keep printable input (incl. CJK).
      if (char < ' ') continue

      insert(char)
    }

    if (dirty) this.redraw()
  }

  private historyPrev(): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) this.historyIndex = this.history.length
    this.historyIndex = Math.max(0, this.historyIndex - 1)
    this.buffer = this.history[this.historyIndex] ?? ''
    this.cursor = this.buffer.length
  }

  private historyNext(): void {
    if (this.historyIndex === -1) return
    this.historyIndex++
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = -1
      this.buffer = ''
    } else {
      this.buffer = this.history[this.historyIndex] ?? ''
    }
    this.cursor = this.buffer.length
  }
}

interface ConfigChoice {
  /** Raw value to send back to the server. */
  value: string
  /** Display name advertised by the server. */
  label: string
  /** `provider/model` when the value encodes an ACP model route. */
  route: string | null
  /** Bare model id, when derivable. */
  model: string | null
}

interface ModelState {
  current: string | null
  choices: ConfigChoice[]
  currentReasoning: string | null
  reasoningChoices: ConfigChoice[]
}

function emptyModelState(): ModelState {
  return { current: null, choices: [], currentReasoning: null, reasoningChoices: [] }
}

/** ACP encodes the model option value as `JSON.stringify([provider, model])`. */
function decodeRoute(value: unknown): { route: string | null; model: string | null } {
  if (typeof value !== 'string') return { route: null, model: null }
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.length === 2) {
      const provider = String(parsed[0])
      const model = String(parsed[1])
      return { route: `${provider}/${model}`, model }
    }
  } catch {
    /* not a JSON-encoded route */
  }
  return { route: null, model: null }
}

function flattenChoices(options: unknown, group: string | null = null): ConfigChoice[] {
  if (!Array.isArray(options)) return []

  const choices: ConfigChoice[] = []
  for (const option of options) {
    if (!option || typeof option !== 'object') continue
    const record = option as Record<string, unknown>

    if (typeof record.value === 'string') {
      const decoded = decodeRoute(record.value)
      const label = typeof record.name === 'string' && record.name ? record.name : decoded.route ?? record.value
      choices.push({
        value: record.value,
        label: group && !decoded.route ? `${group}/${label}` : label,
        route: decoded.route,
        model: decoded.model
      })
      continue
    }

    if (Array.isArray(record.options)) {
      const nestedGroup = group ?? (typeof record.group === 'string' ? record.group : null)
      choices.push(...flattenChoices(record.options, nestedGroup))
    }
  }

  return choices
}

function parseConfigOptions(options: unknown): ModelState {
  const state = emptyModelState()
  if (!Array.isArray(options)) return state

  for (const option of options) {
    if (!option || typeof option !== 'object') continue
    const record = option as Record<string, unknown>

    if (record.id === 'model') {
      const decoded = decodeRoute(record.currentValue)
      state.current =
        decoded.route ?? (typeof record.currentValue === 'string' ? record.currentValue : null)
      state.choices = flattenChoices(record.options)
    } else if (record.id === 'reasoning_effort') {
      state.currentReasoning = typeof record.currentValue === 'string' ? record.currentValue : null
      state.reasoningChoices = flattenChoices(record.options)
    }
  }

  return state
}

function findChoice(choices: ConfigChoice[], requested: string): ConfigChoice | null {
  const wanted = requested.trim()
  if (!wanted) return null
  const lower = wanted.toLowerCase()

  return (
    choices.find((choice) => choice.route?.toLowerCase() === lower) ??
    choices.find((choice) => choice.model?.toLowerCase() === lower) ??
    choices.find((choice) => choice.label.toLowerCase() === lower) ??
    choices.find((choice) => choice.label.toLowerCase().endsWith(`/${lower}`)) ??
    null
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()
  oneShot = args.prompt !== null

  let editor: LineEditor
  let submitHandler: (line: string) => void = () => undefined

  const session = { id: null as string | null, ready: false, busy: false, exiting: false }
  const queued: string[] = []
  let inputClosed = false
  let statusInterval: ReturnType<typeof setInterval> | null = null
  let modelState = emptyModelState()
  /**
   * Assistant messages are committed blocks without a trailing newline, so the
   * cursor can be left mid-line. Repainting the prompt line with `\r\u001b[K`
   * would then erase the message, so remember it and finish the line first.
   */
  let partialLine = false

  const writeStderr = (line: string): void => {
    clearStatus()
    write(renderInfo(`[dsh] ${line}`))
    refreshEditor()
  }

  const { transport, describe } = spawnDshAcp(args, cwd, writeStderr)
  const client = new AcpClient(transport, { requestTimeoutMs: 60_000 })
  const renderState = createRenderState()

  function clearStatus(): void {
    if (statusInterval) {
      clearInterval(statusInterval)
      statusInterval = null
      write('\r\u001b[K')
    }
  }

  function startStatus(): void {
    if (statusInterval) return
    const startedAt = Date.now()
    statusInterval = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      write(`\r\u001b[K${DIM}… working ${seconds}s (Ctrl-C to cancel)${RESET}`)
    }, 1000)
  }

  /** Repaint the prompt after output, finishing a partial line first. */
  function refreshEditor(): void {
    if (partialLine) {
      write('\n')
      partialLine = false
    }
    editor.refresh()
  }

  function renderChunk(text: string): void {
    if (!text) return
    clearStatus()
    write(text)
    partialLine = !text.endsWith('\n')
    refreshEditor()
  }

  async function shutdown(code: number): Promise<void> {
    if (session.exiting) return
    session.exiting = true
    clearStatus()
    editor.disable()
    try {
      if (session.id && !client.isClosed) await client.closeSession(session.id)
    } catch {
      /* best effort */
    }
    try {
      client.close()
    } catch {
      /* already gone */
    }
    process.exit(code)
  }

  async function runPrompt(text: string): Promise<{ stopReason: string | undefined; failed: boolean }> {
    if (!session.id) return { stopReason: undefined, failed: true }
    write(renderPrompt(text))
    session.busy = true
    startStatus()
    try {
      const result = await client.prompt(session.id, [{ type: 'text', text }])
      clearStatus()
      const tail = renderTurnEnd(result.stopReason)
      write(tail || '\n')
      return { stopReason: result.stopReason, failed: false }
    } catch (error) {
      clearStatus()
      write(renderError(describeAcpError(error)))
      return { stopReason: undefined, failed: true }
    } finally {
      session.busy = false
      refreshEditor()
    }
  }

  async function applyModel(requested: string): Promise<void> {
    if (!session.id) return
    const choice = findChoice(modelState.choices, requested)
    if (!choice) {
      write(renderError(`Unknown DSH model "${requested}". Use /model to list the live catalog.`))
      return
    }
    try {
      const result = await client.setConfigOption(session.id, 'model', choice.value)
      modelState = parseConfigOptions(result.configOptions)
      write(renderInfo(`model → ${modelState.current ?? choice.label}`))
    } catch (error) {
      write(renderError(describeAcpError(error)))
    }
  }

  async function applyReasoning(requested: string): Promise<void> {
    if (!session.id) return
    const choice = findChoice(modelState.reasoningChoices, requested)
    if (!choice) {
      write(renderError(`Unknown reasoning effort "${requested}".`))
      return
    }
    try {
      const result = await client.setConfigOption(session.id, 'reasoning_effort', choice.value)
      modelState = parseConfigOptions(result.configOptions)
      write(renderInfo(`reasoning → ${modelState.currentReasoning ?? requested}`))
    } catch (error) {
      write(renderError(describeAcpError(error)))
    }
  }

  async function handleCommand(text: string): Promise<void> {
    const [command, ...rest] = text.split(/\s+/)
    const argument = rest.join(' ')

    switch (command) {
      case '/help':
        write(
          [
            'Commands',
            '  /model [route]   show or switch the model (e.g. /model deepseek-official/deepseek-v4-pro)',
            '  /reasoning <x>   set the reasoning effort',
            '  /status          session, workspace, and model state',
            '  /cancel          cancel the running turn',
            '  /exit            close the session (Ctrl-D also works)'
          ].join('\n') + '\n'
        )
        break

      case '/model':
        if (!argument) {
          write(renderInfo(`current model: ${modelState.current ?? 'provider default'}`))
          if (modelState.choices.length > 0) {
            write(renderInfo(`available: ${modelState.choices.map((choice) => choice.label).join(', ')}`))
          }
        } else {
          await applyModel(argument)
        }
        break

      case '/reasoning':
        if (!argument) {
          write(renderInfo(`current reasoning: ${modelState.currentReasoning ?? 'default'}`))
          if (modelState.reasoningChoices.length > 0) {
            write(
              renderInfo(`available: ${modelState.reasoningChoices.map((choice) => choice.label).join(', ')}`)
            )
          }
        } else {
          await applyReasoning(argument)
        }
        break

      case '/status':
        write(renderInfo(`session: ${session.id ?? 'none'}`))
        write(renderInfo(`workspace: ${cwd}`))
        write(renderInfo(`model: ${modelState.current ?? 'provider default'}`))
        write(renderInfo(`transport: ${describe}`))
        break

      case '/cancel':
        if (session.id && session.busy) {
          client.cancel(session.id)
          write(renderInfo('cancellation requested'))
        } else {
          write(renderInfo('nothing to cancel'))
        }
        break

      case '/exit':
        await shutdown(0)
        break

      default:
        write(renderError(`Unknown command ${command}. Try /help.`))
        break
    }

    refreshEditor()
  }

  async function handleLine(line: string): Promise<void> {
    if (session.exiting) return

    if (line === '\u0004') {
      write(renderInfo('closing DSH session…'))
      await shutdown(0)
      return
    }

    if (line === '\u0003') {
      if (session.busy && session.id) {
        client.cancel(session.id)
        write(renderInfo('cancellation requested'))
        refreshEditor()
      }
      return
    }

    const text = line.trim()
    if (!text) return

    if (text.startsWith('/')) {
      await handleCommand(text)
      return
    }

    if (!session.ready || !session.id) {
      if (queued.length < MAX_QUEUED_PROMPTS) {
        queued.push(line)
        write(renderInfo('queued until the DSH session is ready'))
      } else {
        write(renderError('Too many queued prompts; wait for the session to start.'))
      }
      refreshEditor()
      return
    }

    if (session.busy) {
      write(renderError('A turn is already running. Press Ctrl-C to cancel it.'))
      refreshEditor()
      return
    }

    await runPrompt(text)
  }

  editor = new LineEditor(
    (line) => submitHandler(line),
    () => {
      // stdin closed: finish whatever is queued, then leave. Before the session
      // is ready there is nothing to run yet — startup() drains it afterwards.
      inputClosed = true
      editor.disable()
      if (session.ready) void drainAndExit()
    }
  )
  submitHandler = (line) => {
    void handleLine(line)
  }

  async function drainAndExit(): Promise<void> {
    if (!session.ready) return
    while (queued.length > 0) {
      const next = queued.shift()
      if (next) await runPrompt(next)
    }
    if (inputClosed && !session.busy) await shutdown(0)
  }

  // ── Server → client traffic ───────────────────────────────────────────────

  client.on('notification', (message: { method: string; params?: unknown }) => {
    if (message.method !== 'session/update' || !message.params) return
    const params = message.params as { sessionId?: string; update?: AcpSessionUpdate }
    if (!params.update) return

    if (oneShot) {
      // Headless: the answer is stdout, everything else is progress on stderr.
      if (params.update.sessionUpdate === 'agent_message_chunk') {
        writeAnswer(textFromContentBlock(params.update.content as AcpContentBlock))
      }
      const logLine = renderUpdate(renderState, params.update)
      if (logLine) process.stderr.write(stripAnsi(logLine))
      return
    }

    renderChunk(renderUpdate(renderState, params.update))
  })

  client.on('request', (message: { id: number | string; method: string; params?: unknown }) => {
    if (message.method !== 'session/request_permission') {
      // Unknown server request: answer with method-not-found so it never hangs.
      client.respondWithError(message.id, -32601, `Unsupported client method: ${message.method}`)
      return
    }

    const request = (message.params ?? {}) as AcpPermissionRequest
    const options = request.options ?? []
    const allow = options.find((option) => option.kind === 'allow_once' || option.optionId === 'allow-once')
    const reject = options.find((option) => option.kind === 'reject_once' || option.optionId === 'reject-once')

    // DSH sends only `{ toolCallId }` here, so fall back to the title the
    // preceding tool_call update already rendered.
    const callId = request.toolCall?.toolCallId
    const title =
      (typeof request.toolCall?.title === 'string' && request.toolCall.title) ||
      (callId ? renderState.toolTitles.get(callId) : undefined) ||
      (callId ? `tool call ${callId}` : 'tool call')

    const respond = (allowed: boolean): void => {
      const chosen = allowed ? allow : reject
      if (!chosen) {
        client.respondWithResult(message.id, { outcome: { outcome: 'cancelled' } })
        return
      }
      client.respondWithResult(message.id, { outcome: { outcome: 'selected', optionId: chosen.optionId } })
    }

    clearStatus()

    if (oneShot) {
      // Nobody is watching stdin, so never block on an interactive answer.
      const allowed = args.yolo && Boolean(allow)
      write(
        renderInfo(
          allowed
            ? `auto-approved: ${title}`
            : `denied (headless run without --yolo): ${title}`
        )
      )
      respond(allowed)
      return
    }

    if (args.yolo && allow) {
      write(renderInfo(`auto-approved: ${title}`))
      refreshEditor()
      respond(true)
      return
    }

    write(renderPermissionPrompt({ title }))
    void editor.ask(`${YELLOW}allow? [y/N]${RESET} `).then((answer) => {
      const allowed = /^y(es)?$/i.test(answer.trim())
      respond(allowed)
      write(renderInfo(allowed ? 'allowed once' : 'rejected'))
      refreshEditor()
    })
  })

  client.on('protocol-error', (error: Error) => {
    renderChunk(renderError(`protocol error: ${error.message}`))
  })

  client.on('closed', (error?: Error) => {
    clearStatus()
    if (!session.exiting) {
      write(renderError(error ? error.message : 'DSH connection closed'))
      void shutdown(1)
    }
  })

  // ── Startup ───────────────────────────────────────────────────────────────

  async function startup(): Promise<void> {
    write(renderInfo(`starting ${describe} in ${cwd}`))
    refreshEditor()

    await client.initialize(CLIENT_INFO)

    if (args.resumeSessionId) {
      const result = await client.resumeSession(args.resumeSessionId, cwd)
      session.id = args.resumeSessionId
      modelState = parseConfigOptions(result.configOptions)
    } else {
      const result = await client.newSession(cwd)
      session.id = result.sessionId
      modelState = parseConfigOptions(result.configOptions)
    }

    renderChunk(
      renderBanner({
        cwd,
        model: modelState.current,
        sessionId: session.id,
        resumed: Boolean(args.resumeSessionId)
      })
    )

    if (args.model) await applyModel(args.model)
    if (args.reasoningEffort) await applyReasoning(args.reasoningEffort)

    session.ready = true
    refreshEditor()

    if (args.prompt !== null) {
      // Headless: one turn, then exit with the outcome in the exit code.
      const outcome = await runPrompt(args.prompt)
      const failed =
        outcome.failed || outcome.stopReason === 'cancelled' || outcome.stopReason === 'refusal'
      await shutdown(failed ? 1 : 0)
      return
    }

    // Flush anything typed while the session was starting up.
    await drainAndExit()
  }

  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))
  process.on('uncaughtException', (error) => {
    write(renderError(describeAcpError(error)))
    void shutdown(1)
  })

  if (!oneShot) editor.start()

  const startupTimer = setTimeout(() => {
    write(renderError(`DSH did not answer initialize within ${STARTUP_TIMEOUT_MS / 1000}s`))
    void shutdown(1)
  }, STARTUP_TIMEOUT_MS)

  try {
    await startup()
  } catch (error) {
    clearTimeout(startupTimer)
    write(renderError(describeAcpError(error)))
    await shutdown(1)
    return
  }
  clearTimeout(startupTimer)
}

void main()
