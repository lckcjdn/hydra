import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import type { ClaudeSessionSummary } from '@shared/types'
import type { ListSessionOptions } from './SessionCatalog'

/**
 * Reads the sessions DSH already has on disk so Hydra can list and resume them.
 *
 * DSH keeps two complementary stores under `$DSH_HOME` (default `~/.dsh`):
 *
 *   sessions/<encoded-workspace>/<sessionId>/session.v3.jsonl.zstd
 *       the append-only log; its mtime is the session's last activity.
 *   storages/session_projcache/sessions/<sessionId>.json
 *       the projection cache: cwd, title, first prompt, turn count, and the
 *       flags that distinguish a root session from a subagent session.
 *
 * The log itself is a chain of independent Zstandard frames, so this catalog
 * deliberately reads only the projection cache and file metadata. That is
 * everything a resumable sidebar entry needs — the conversation content is
 * restored by DSH itself when the session is resumed over ACP.
 */
interface ProjcacheRow<T = unknown> {
  val?: T
}

interface ProjcacheRecord {
  version?: number
  record?: {
    identity?: {
      createdAt?: number
      cwd?: string
      isSeeded?: boolean
    }
    rows?: {
      title?: ProjcacheRow<string>
      titleInput?: ProjcacheRow<{ first?: { text?: string } }>
      sessionStats?: ProjcacheRow<{ turns?: number }>
      subagent?: ProjcacheRow<{ identity?: unknown }>
    }
  }
}

interface AggregateProjcache {
  tables?: {
    sessions?: Record<string, { identity?: { createdAt?: number; cwd?: string } }>
  }
}

const DEFAULT_DSH_HOME = join(homedir(), '.dsh')
const SESSION_CACHE_TTL_MS = 5000
/**
 * DSH log filenames: the current generation is `session.v3.jsonl.zstd`, older
 * sessions (the majority on a long-lived install) are `session.jsonl.zstd`.
 * Both are read by the same persistence layer, so both are resumable.
 */
const SESSION_LOG_PATTERN = /^session(?:\.v\d+)?\.jsonl(\.zst|\.zstd|\.gz)?$/

function normalizePathForComparison(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Best-effort inverse of DSH's workspace directory encoding
 * (`D:\Projects\hydra` → `--D-Projects-hydra--`). Path separators become `-`
 * and every other non-alphanumeric becomes a `~XXXX` code-point escape, so a
 * literal `-` inside a directory name is indistinguishable from a separator.
 * Only used when the projection cache has no cwd.
 */
export function decodeWorkspaceDirName(encoded: string): string {
  const inner = encoded.replace(/^--/, '').replace(/--$/, '')
  const unescaped = inner.replace(/~([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )

  const parts = unescaped.split('-')
  const drive = parts[0] ?? ''
  if (process.platform === 'win32' && /^[A-Za-z]$/.test(drive)) {
    return `${drive}:\\${parts.slice(1).join('\\')}`
  }
  return parts.join('/')
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export class DshSessionCatalog {
  private cache: { sessions: ClaudeSessionSummary[]; expiresAt: number } | null = null

  constructor(
    private readonly dshHome: string = DEFAULT_DSH_HOME,
    private readonly cacheTtlMs: number = SESSION_CACHE_TTL_MS
  ) {}

  listSessions(options: ListSessionOptions = {}): ClaudeSessionSummary[] {
    const sessions = this.getSessionSnapshot(options.forceRefresh === true)

    const hiddenIds = new Set(options.hiddenSessionIds ?? [])
    const projectPrefix = options.projectPathPrefix?.trim()
    const normalizedProjectPrefix = projectPrefix ? normalizePathForComparison(projectPrefix) : null
    const cutoff =
      typeof options.maxAgeDays === 'number' && options.maxAgeDays > 0
        ? Date.now() - options.maxAgeDays * 86_400_000
        : 0

    const filtered = sessions.filter((session) => {
      if (hiddenIds.has(session.sessionId)) return false
      if (normalizedProjectPrefix) {
        const normalizedSessionPath = normalizePathForComparison(session.projectPath)
        if (!normalizedSessionPath.startsWith(normalizedProjectPrefix)) return false
      }
      if (cutoff > 0 && Date.parse(session.modifiedAt) < cutoff) return false
      return true
    })

    filtered.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))

    if (typeof options.limit === 'number' && options.limit > 0) {
      return filtered.slice(0, options.limit)
    }
    return filtered
  }

  invalidateCache(): void {
    this.cache = null
  }

  private getSessionSnapshot(forceRefresh: boolean): ClaudeSessionSummary[] {
    if (forceRefresh || this.cacheTtlMs <= 0) return this.refreshCache()

    const now = Date.now()
    if (this.cache && this.cache.expiresAt > now) return this.cache.sessions
    return this.refreshCache()
  }

  private refreshCache(): ClaudeSessionSummary[] {
    const sessions = this.scanSessions()
    if (this.cacheTtlMs > 0) {
      this.cache = { sessions, expiresAt: Date.now() + this.cacheTtlMs }
    } else {
      this.cache = null
    }
    return sessions
  }

  private scanSessions(): ClaudeSessionSummary[] {
    const sessionsRoot = join(this.dshHome, 'sessions')
    if (!existsSync(sessionsRoot)) return []

    let workspaceDirs: string[] = []
    try {
      workspaceDirs = readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sessionsRoot, entry.name))
    } catch {
      return []
    }

    // The aggregate cache is one large JSON file; only load it if some session
    // has no per-session record.
    let aggregateCwd: Map<string, string> | null = null
    const lazyAggregateCwd = (): Map<string, string> => {
      aggregateCwd ??= this.readAggregateCwd()
      return aggregateCwd
    }

    const sessions: ClaudeSessionSummary[] = []
    const seen = new Set<string>()

    for (const workspaceDir of workspaceDirs) {
      let sessionDirs: string[] = []
      try {
        sessionDirs = readdirSync(workspaceDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(workspaceDir, entry.name))
      } catch {
        continue
      }

      for (const sessionDir of sessionDirs) {
        const sessionId = basename(sessionDir)
        if (seen.has(sessionId)) continue

        const logPath = this.findSessionLog(sessionDir)
        if (!logPath) continue

        const session = this.readSession(sessionId, basename(workspaceDir), logPath, lazyAggregateCwd)
        if (!session) continue

        seen.add(sessionId)
        sessions.push(session)
      }
    }

    return sessions
  }

  private findSessionLog(sessionDir: string): string | null {
    try {
      const entries = readdirSync(sessionDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && SESSION_LOG_PATTERN.test(entry.name))
        .map((entry) => join(sessionDir, entry.name))

      if (entries.length === 0) return null

      // Prefer the highest format generation.
      entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      return entries[entries.length - 1]
    } catch {
      return null
    }
  }

  private readSession(
    sessionId: string,
    encodedWorkspace: string,
    logPath: string,
    aggregateCwd: () => Map<string, string>
  ): ClaudeSessionSummary | null {
    let modifiedAt: string
    try {
      modifiedAt = statSync(logPath).mtime.toISOString()
    } catch {
      return null
    }

    const record = this.readProjcacheRecord(sessionId)
    const rows = record?.record?.rows
    const identity = record?.record?.identity

    // Child (subagent) sessions cannot be resumed over ACP: DSH rejects any
    // session whose origin is `subagent` or that has a parent session.
    if (rows?.subagent?.val && typeof rows.subagent.val === 'object') {
      if ('identity' in (rows.subagent.val as Record<string, unknown>)) return null
    }

    const cwd =
      identity?.cwd || aggregateCwd().get(sessionId) || decodeWorkspaceDirName(encodedWorkspace)

    if (!cwd) return null

    const firstPrompt = (rows?.titleInput?.val?.first?.text ?? '').trim()
    const title = (rows?.title?.val ?? '').trim()
    const turns = rows?.sessionStats?.val?.turns

    return {
      sessionId,
      projectPath: cwd,
      firstPrompt: firstPrompt || title,
      messageCount: typeof turns === 'number' && turns > 0 ? turns : 0,
      createdAt: toIso(identity?.createdAt) ?? modifiedAt,
      modifiedAt,
      gitBranch: null,
      isSidechain: false,
      sourcePath: logPath
    }
  }

  private readProjcacheRecord(sessionId: string): ProjcacheRecord | null {
    const path = join(this.dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    if (!existsSync(path)) return null

    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as ProjcacheRecord
    } catch {
      return null
    }
  }

  /** Fallback cwd source for sessions the per-session cache has not covered. */
  private readAggregateCwd(): Map<string, string> {
    const result = new Map<string, string>()
    const path = join(this.dshHome, 'storages', 'session_projcache.json')
    if (!existsSync(path)) return result

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AggregateProjcache
      const sessions = parsed.tables?.sessions ?? {}
      for (const [sessionId, entry] of Object.entries(sessions)) {
        if (typeof entry?.identity?.cwd === 'string' && entry.identity.cwd) {
          result.set(sessionId, entry.identity.cwd)
        }
      }
    } catch {
      /* best effort */
    }

    return result
  }
}
