import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import type {
  OrchestrationState,
  OrchestrationEvent,
  AgentGroup,
  HarnessSession,
  QuotaPool,
  TaskAssignment,
  SessionCheckpoint,
  HandoffRecord
} from '@shared/types'

const STATE_SCHEMA_VERSION = 1

const DEFAULT_STATE: OrchestrationState = {
  schemaVersion: STATE_SCHEMA_VERSION,
  groups: [],
  sessions: [],
  quotaPools: [],
  tasks: [],
  checkpoints: [],
  handoffs: []
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Durable store for orchestration state (groups, sessions, quota pools, tasks,
 * checkpoints, handoffs) plus the append-only event journal.
 *
 * State lives in `orchestration.json`; the journal is an append-only JSONL file
 * (`orchestration-events.jsonl`) so re-running a daemon never loses handoff or
 * quota history. A null dataDir runs in-memory only (unit tests).
 */
export class OrchestrationStore {
  private state: OrchestrationState
  private readonly statePath: string | null
  private readonly eventsPath: string | null

  constructor(dataDir: string | null) {
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true })
      this.statePath = join(dataDir, 'orchestration.json')
      this.eventsPath = join(dataDir, 'orchestration-events.jsonl')
    } else {
      this.statePath = null
      this.eventsPath = null
    }
    this.state = this.loadState()
  }

  getState(): OrchestrationState {
    return this.cloneState(this.state)
  }

  getGroups(): AgentGroup[] {
    return this.state.groups.map((g) => ({ ...g }))
  }

  getSessions(): HarnessSession[] {
    return this.state.sessions.map((s) => ({ ...s }))
  }

  getQuotaPools(): QuotaPool[] {
    return this.state.quotaPools.map((q) => ({ ...q }))
  }

  getTasks(): TaskAssignment[] {
    return this.state.tasks.map((t) => ({ ...t }))
  }

  getCheckpoints(): SessionCheckpoint[] {
    return this.state.checkpoints.map((c) => ({ ...c }))
  }

  getHandoffs(): HandoffRecord[] {
    return this.state.handoffs.map((h) => ({ ...h }))
  }

  /** Replace a single slice and persist. Returns the new snapshot. */
  update(
    patch: Partial<Pick<OrchestrationState, 'groups' | 'sessions' | 'quotaPools' | 'tasks' | 'checkpoints' | 'handoffs'>>
  ): OrchestrationState {
    this.state = {
      ...this.state,
      ...patch,
      schemaVersion: STATE_SCHEMA_VERSION
    }
    this.persistState()
    return this.cloneState(this.state)
  }

  appendEvent(event: OrchestrationEvent): void {
    if (!this.eventsPath) return
    try {
      appendFileSync(this.eventsPath, JSON.stringify(event) + '\n', 'utf-8')
    } catch (err) {
      console.error('[orchestration] Failed to append event:', err)
    }
  }

  loadEvents(): OrchestrationEvent[] {
    if (!this.eventsPath || !existsSync(this.eventsPath)) return []
    try {
      const raw = readFileSync(this.eventsPath, 'utf-8')
      const events: OrchestrationEvent[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as OrchestrationEvent
          if (this.isEvent(parsed)) events.push(parsed)
        } catch {
          // Skip corrupt lines.
        }
      }
      return events
    } catch (err) {
      console.error('[orchestration] Failed to read event journal:', err)
      return []
    }
  }

  private loadState(): OrchestrationState {
    const empty = { ...DEFAULT_STATE, groups: [], sessions: [], quotaPools: [], tasks: [], checkpoints: [], handoffs: [] }
    if (!this.statePath) {
      return empty
    }
    try {
      if (!existsSync(this.statePath)) {
        this.writeState(empty)
        return empty
      }
      const raw = readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<OrchestrationState>
      return {
        schemaVersion: STATE_SCHEMA_VERSION,
        groups: isRecord(parsed) && Array.isArray(parsed.groups) ? parsed.groups.filter(isGroup) : [],
        sessions: isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions.filter(isSession) : [],
        quotaPools: isRecord(parsed) && Array.isArray(parsed.quotaPools) ? parsed.quotaPools.filter(isQuotaPool) : [],
        tasks: isRecord(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTask) : [],
        checkpoints: isRecord(parsed) && Array.isArray(parsed.checkpoints) ? parsed.checkpoints.filter(isCheckpoint) : [],
        handoffs: isRecord(parsed) && Array.isArray(parsed.handoffs) ? parsed.handoffs.filter(isHandoff) : []
      }
    } catch (err) {
      console.error('[orchestration] Failed to load state, resetting:', err)
      this.writeState(empty)
      return empty
    }
  }

  private persistState(): void {
    this.writeState(this.state)
  }

  private writeState(state: OrchestrationState): void {
    if (!this.statePath) return
    try {
      writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      console.error('[orchestration] Failed to persist state:', err)
    }
  }

  private cloneState(state: OrchestrationState): OrchestrationState {
    return JSON.parse(JSON.stringify(state)) as OrchestrationState
  }

  private isEvent(value: unknown): value is OrchestrationEvent {
    if (!isRecord(value)) return false
    return typeof value.eventId === 'string' && typeof value.type === 'string' && typeof value.sequence === 'number'
  }
}

const PROVIDERS = ['claude', 'codex', 'opencode', 'dsh']

function isGroup(value: unknown): value is AgentGroup {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.name === 'string' && isStringArray(value.sessionIds)
}

function isSession(value: unknown): value is HarnessSession {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.provider === 'string' &&
    PROVIDERS.includes(value.provider) &&
    typeof value.cwd === 'string' &&
    typeof value.projectRef === 'string' &&
    typeof value.role === 'string'
  )
}

function isQuotaPool(value: unknown): value is QuotaPool {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.accountAlias === 'string' &&
    typeof value.availability === 'string'
  )
}

function isTask(value: unknown): value is TaskAssignment {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.groupId === 'string' && typeof value.goal === 'string'
}

function isCheckpoint(value: unknown): value is SessionCheckpoint {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.sessionId === 'string' && typeof value.capturedAt === 'string'
}

function isHandoff(value: unknown): value is HandoffRecord {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.groupId === 'string' && typeof value.taskId === 'string'
}
