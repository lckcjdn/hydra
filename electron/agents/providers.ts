import { PROVIDER_MODELS, type AgentState, type ProviderId, type ModelId } from '@shared/types'
import { execFileSync } from 'child_process'
import { join, sep } from 'path'

/** A fully resolved process to spawn, bypassing PATH lookup for the provider CLI. */
export interface ProviderSpawnSpec {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export interface ProviderConfig {
  id: ProviderId
  /** CLI command name (e.g. 'claude', 'codex') */
  command: string
  /** Build CLI arguments from agent state */
  buildArgs(state: AgentState): string[]
  /** Build CLI arguments for headless (non-interactive) runs */
  buildHeadlessArgs(model: ModelId, prompt: string, resumeSessionId: string | null, reasoningEffort?: string): string[]
  /** Whether this provider supports --resume */
  supportsResume: boolean
  /** CLI flag for auto-approve / YOLO mode, or null if unsupported */
  yoloFlag: string | null
  /** Regex to detect session IDs from PTY output, or null */
  sessionIdRegex: RegExp | null
  /**
   * Optional override for the PTY spawn target. Providers that run their own
   * runtime instead of a plain CLI (DSH runs a bundled ACP bridge through
   * Electron's Node) return the exact executable, argv, and env here; the
   * resolved `command` is still passed through the user's shell wrapper.
   */
  resolveSpawn?(state: AgentState): ProviderSpawnSpec
  /**
   * Optional override for headless (one-shot) spawn targets.
   */
  resolveHeadlessSpawn?(
    model: ModelId,
    prompt: string,
    resumeSessionId: string | null,
    reasoningEffort?: string
  ): ProviderSpawnSpec
  /**
   * Windows only: the PTY child is a shell shim (`cmd.exe`) with the real CLI as
   * a grandchild, so killing the PTY child alone orphans the CLI. Providers that
   * set this get their whole process tree taken down on stop/restart.
   */
  killTreeOnStop?: boolean
  /** Check if the CLI binary is available. Returns path + version or error. */
  preflight(): Promise<{
    ok: boolean
    path: string | null
    version: string | null
    error: string | null
  }>
}

interface ProviderPreflightResult {
  ok: boolean
  path: string | null
  version: string | null
  error: string | null
}

function resolveCommandPath(command: string): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    const output = execFileSync(locator, [command], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    const firstLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    return firstLine ?? null
  } catch {
    return null
  }
}

function readVersion(commandPath: string, command: string): string | null {
  const targets = commandPath === command ? [commandPath] : [command, commandPath]
  for (const target of targets) {
    try {
      const output = execFileSync(target, ['--version'], {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()
      if (output.length > 0) return output
    } catch {
      continue
    }
  }
  return null
}

function runPreflight(command: string, missingError: string): ProviderPreflightResult {
  const path = resolveCommandPath(command)
  if (!path) {
    return {
      ok: false,
      path: null,
      version: null,
      error: missingError
    }
  }

  return {
    ok: true,
    path,
    version: readVersion(path, command),
    error: null
  }
}

// ── Claude Provider ─────────────────────────────────────────────────────────

const claudeProvider: ProviderConfig = {
  id: 'claude',
  command: 'claude',
  supportsResume: true,
  yoloFlag: '--dangerously-skip-permissions',
  sessionIdRegex: /session(?:[_\s-]?id)?[:=\s]+([a-z0-9-]{8,})/i,

  buildArgs(state: AgentState): string[] {
    const args: string[] = []
    if (state.yolo) args.push('--dangerously-skip-permissions')
    args.push('--model', state.model)
    if (state.sessionId) args.push('--resume', state.sessionId)
    return args
  },

  buildHeadlessArgs(model: ModelId, prompt: string, resumeSessionId: string | null, _reasoningEffort?: string): string[] {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--model', model]
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    return args
  },

  async preflight() {
    return runPreflight('claude', 'Claude CLI not found. Install it from https://claude.ai/download')
  }
}

// ── Codex Provider ──────────────────────────────────────────────────────────

const codexProvider: ProviderConfig = {
  id: 'codex',
  command: 'codex',
  supportsResume: true,
  yoloFlag: '--full-auto',
  sessionIdRegex: null,

  buildArgs(state: AgentState): string[] {
    const args: string[] = []
    if (state.sessionId) {
      args.push('resume', state.sessionId)
    }
    if (state.yolo) args.push('--full-auto')
    args.push('--model', state.model)
    if (state.reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${state.reasoningEffort}"`)
    }
    return args
  },

  buildHeadlessArgs(model: ModelId, prompt: string, _resumeSessionId: string | null, reasoningEffort?: string): string[] {
    const args = ['--model', model, '-q', prompt]
    if (reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)
    }
    return args
  },

  async preflight() {
    return runPreflight('codex', 'Codex CLI not found. Install it with: npm install -g @openai/codex or bun add -g @openai/codex')
  }
}

// ── OpenCode Provider ──────────────────────────────────────────────────────

const opencodeProvider: ProviderConfig = {
  id: 'opencode',
  command: 'opencode',
  supportsResume: true,
  yoloFlag: null,
  sessionIdRegex: /session(?:[_\s-]?id)?[:=\s]+([a-z0-9-]{8,})/i,

  buildArgs(state: AgentState): string[] {
    const args: string[] = []
    args.push('--model', state.model)
    if (state.sessionId) args.push('--session', state.sessionId)
    return args
  },

  buildHeadlessArgs(model: ModelId, prompt: string, resumeSessionId: string | null, _reasoningEffort?: string): string[] {
    const args = ['-p', prompt, '--output-format', 'text', '--model', model]
    if (resumeSessionId) args.push('--session', resumeSessionId)
    return args
  },

  async preflight() {
    return runPreflight('opencode', 'OpenCode CLI not found. Install it from https://opencode.ai')
  }
}

// ── DSH (DeepSeek Harness) Provider ────────────────────────────────────────

/**
 * DSH has no terminal front-end of its own: its interactive surfaces are a
 * browser UI and an automation-only ACP server. Hydra therefore runs a small
 * bridge process inside the agent tile that speaks ACP to
 * `dsh --profile acp` and renders the conversation as terminal output.
 *
 * The bridge is a second entry of the main-process bundle (see
 * electron.vite.config.ts).
 *
 * It must run under a **real Node**, not under Electron's own runtime: Hydra
 * tiles are ConPTYs on Windows and Electron's binary is a GUI-subsystem
 * executable, so `ELECTRON_RUN_AS_NODE` inside a ConPTY runs but writes zero
 * bytes — a silently blank tile. DSH is itself a Node CLI, so Node is present
 * on any machine where `dsh` works at all.
 */
/**
 * Where the packaged app keeps the DSH bridge. Stock Node cannot read inside
 * `app.asar`, so a packaged build runs the copy electron-builder unpacks next
 * to the archive (see electron-builder.yml → asarUnpack).
 */
export function resolveBridgePath(bundledDir: string): string {
  const bundled = join(bundledDir, 'dshBridge.js')
  const marker = `app.asar${sep}`
  return bundled.includes(marker) ? bundled.replace(marker, `app.asar.unpacked${sep}`) : bundled
}

function dshBridgePath(): string {
  return resolveBridgePath(__dirname)
}

const DSH_BRIDGE_ENV: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }

/** Cached result of the Node lookup (`undefined` = not resolved yet). */
let cachedNodeBinary: string | null | undefined

/**
 * Locate a Node executable that actually runs. The Microsoft Store app
 * execution aliases for `node` resolve through PATH but exit without doing
 * anything, so the candidate is validated with `--version`.
 */
function resolveNodeBinary(): string | null {
  if (cachedNodeBinary !== undefined) return cachedNodeBinary

  const candidate = resolveCommandPath('node')
  if (!candidate) {
    cachedNodeBinary = null
    return cachedNodeBinary
  }

  const version = readVersion(candidate, 'node')
  cachedNodeBinary = version && /^v\d+\./.test(version) ? candidate : null
  return cachedNodeBinary
}

function resolveDshBridgeSpawn(args: string[]): ProviderSpawnSpec {
  const bridge = dshBridgePath()
  const node = resolveNodeBinary()
  if (node) {
    return { command: node, args: [bridge, ...args] }
  }

  // Fallback: Electron's runtime. Fine for piped stdio (headless runs) but
  // produces no output in a ConPTY tile, so surface it as a preflight error.
  return { command: process.execPath, args: [bridge, ...args], env: { ...DSH_BRIDGE_ENV } }
}

const dshProvider: ProviderConfig = {
  id: 'dsh',
  command: 'dsh',
  supportsResume: true,
  yoloFlag: '--yolo',
  // The bridge spawns `dsh` through cmd.exe; an orphaned ACP server keeps the
  // session's write handle and makes that session un-resumable.
  killTreeOnStop: true,
  // The bridge prints `session: <uuid>` in one unbroken span (see render.ts →
  // renderBanner, and the render test that pins this against the raw banner).
  sessionIdRegex: /session(?:\s*id)?:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,

  /** argv comes from resolveSpawn, which knows the bridge path. */
  buildArgs(): string[] {
    return []
  },

  /** argv comes from resolveHeadlessSpawn. */
  buildHeadlessArgs(): string[] {
    return []
  },

  resolveSpawn(state: AgentState): ProviderSpawnSpec {
    const args: string[] = []
    if (state.sessionId) args.push('--resume', state.sessionId)
    if (state.model) args.push('--model', state.model)
    if (state.reasoningEffort) args.push('--reasoning-effort', state.reasoningEffort)
    if (state.yolo) args.push('--yolo')
    return resolveDshBridgeSpawn(args)
  },

  resolveHeadlessSpawn(
    model: ModelId,
    prompt: string,
    resumeSessionId: string | null,
    reasoningEffort?: string
  ): ProviderSpawnSpec {
    const args = ['--prompt', prompt]
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    if (model) args.push('--model', model)
    if (reasoningEffort) args.push('--reasoning-effort', reasoningEffort)
    return resolveDshBridgeSpawn(args)
  },

  async preflight() {
    const result = await runPreflight(
      'dsh',
      'DSH CLI not found. Install it with: npm i -g @deepseek-ai/dsh'
    )
    if (result.ok && !resolveNodeBinary()) {
      return {
        ok: false,
        path: result.path,
        version: result.version,
        error:
          'Node.js was not found on PATH. DSH needs it, and Hydra runs the DSH ACP bridge with it.'
      }
    }
    return result
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  claude: claudeProvider,
  codex: codexProvider,
  opencode: opencodeProvider,
  dsh: dshProvider
}

export function getProvider(id: ProviderId): ProviderConfig {
  const provider = PROVIDERS[id]
  if (!provider) throw new Error(`Unknown provider: ${id}`)
  return provider
}

export function getAllProviders(): ProviderConfig[] {
  return Object.values(PROVIDERS)
}

export function isValidModelForProvider(provider: ProviderId, model: ModelId): boolean {
  return PROVIDER_MODELS[provider].some((m) => m.id === model)
}
