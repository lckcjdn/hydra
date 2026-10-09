import type {
  AgentState,
  OrchestrationSnapshot,
  OrchestrationState,
  OrchestrationGroupSummary,
  OrchestrationSessionSummary,
  AddSessionToGroupPayload,
  CreateGroupPayload,
  CreateTaskPayload,
  AssignTaskPayload,
  ReportProgressPayload,
  CaptureCheckpointPayload,
  QuotaMarkPayload,
  HandoffPreparePayload,
  HandoffAcceptPayload,
  HandoffCompletePayload,
  HandoffSyncBackPayload,
  OrchestrationEvent
} from '@shared/types'
import { OrchestrationStore } from './OrchestrationStore'
import { EventJournal } from './EventJournal'
import { GroupManager } from './GroupManager'
import { SessionCoordinator } from './SessionCoordinator'
import { TaskDispatcher } from './TaskDispatcher'
import { CheckpointManager } from './CheckpointManager'
import { HandoffManager } from './HandoffManager'
import { QuotaManager, type ObserveQuotaInput } from '../quota/QuotaManager'

/**
 * Facade over the deterministic Hydra Core services (GroupManager,
 * SessionCoordinator, TaskDispatcher, CheckpointManager, HandoffManager,
 * QuotaManager, EventJournal). This is the single entry point the daemon and
 * MCP server call; it owns no LLM calls and never depends on model quota.
 */
export class OrchestrationService {
  readonly store: OrchestrationStore
  readonly journal: EventJournal
  readonly groups: GroupManager
  readonly sessions: SessionCoordinator
  readonly tasks: TaskDispatcher
  readonly checkpoints: CheckpointManager
  readonly handoffs: HandoffManager
  readonly quota: QuotaManager

  constructor(dataDir: string | null) {
    this.store = new OrchestrationStore(dataDir)
    this.journal = new EventJournal()
    this.journal.setPersistence((event) => this.store.appendEvent(event))
    this.journal.hydrate(this.store.loadEvents())
    this.quota = new QuotaManager(this.store, this.journal)
    this.groups = new GroupManager(this.store, this.journal)
    this.sessions = new SessionCoordinator(this.store, this.journal)
    this.tasks = new TaskDispatcher(this.store, this.journal, this.quota)
    this.checkpoints = new CheckpointManager(this.store, this.journal)
    this.handoffs = new HandoffManager(this.store, this.journal)
  }

  // ── Read ────────────────────────────────────────────────────────────────

  getState(): OrchestrationState {
    return this.store.getState()
  }

  listEvents(groupId?: string | null, limit?: number): OrchestrationEvent[] {
    return this.journal.listForGroup(groupId ?? null, limit ?? 200)
  }

  snapshot(): OrchestrationSnapshot {
    const state = this.store.getState()
    const groups = state.groups.map((group): OrchestrationGroupSummary => {
      const sessions = group.sessionIds
        .map((id) => state.sessions.find((s) => s.id === id))
        .filter((s) => !!s)
        .map((session): OrchestrationSessionSummary => ({
          session,
          quota: session.quotaPoolId ? (state.quotaPools.find((q) => q.id === session.quotaPoolId) ?? null) : null,
          currentTask: session.currentTaskId
            ? (state.tasks.find((t) => t.id === session.currentTaskId) ?? null)
            : null,
          lastCheckpoint: this.checkpoints.latestForSession(session.id)
        }))
      return {
        group,
        sessions,
        tasks: state.tasks.filter((t) => t.groupId === group.id),
        handoffs: state.handoffs.filter((h) => h.groupId === group.id)
      }
    })
    return { state, groups }
  }

  // ── Group ───────────────────────────────────────────────────────────────

  createGroup(payload: CreateGroupPayload) {
    return this.groups.create(payload)
  }

  removeGroup(groupId: string) {
    return this.groups.remove(groupId)
  }

  addSession(payload: AddSessionToGroupPayload) {
    const session = this.sessions.register(payload)
    this.groups.addSession(payload.groupId, session.id)
    return this.sessions.get(session.id)!
  }

  setManager(groupId: string, sessionId: string) {
    return this.groups.setManager(groupId, sessionId)
  }

  suspendSession(sessionId: string) {
    return this.sessions.suspend(sessionId)
  }

  resumeSession(sessionId: string) {
    return this.sessions.resume(sessionId)
  }

  // ── Task / Checkpoint / Handoff / Quota ─────────────────────────────────

  createTask(payload: CreateTaskPayload) {
    return this.tasks.create(payload)
  }

  assignTask(payload: AssignTaskPayload) {
    const task = this.tasks.assign(payload)
    this.store.update({
      sessions: this.store.getSessions().map((s) =>
        s.id === payload.sessionId ? { ...s, currentTaskId: task.id } : s
      )
    })
    return task
  }

  reportProgress(payload: ReportProgressPayload) {
    return this.tasks.reportProgress(payload)
  }

  captureCheckpoint(payload: CaptureCheckpointPayload) {
    return this.checkpoints.capture(payload)
  }

  markQuota(payload: QuotaMarkPayload) {
    return this.quota.mark(payload)
  }

  observeQuota(input: ObserveQuotaInput) {
    return this.quota.observe(input)
  }

  prepareHandoff(payload: HandoffPreparePayload) {
    return this.handoffs.prepare(payload)
  }

  acceptHandoff(payload: HandoffAcceptPayload) {
    return this.handoffs.accept(payload)
  }

  completeHandoff(payload: HandoffCompletePayload) {
    return this.handoffs.complete(payload)
  }

  syncBackHandoff(payload: HandoffSyncBackPayload) {
    return this.handoffs.syncBack(payload)
  }

  /**
   * Reconcile linked session lifecycles from live Hydra agent states. Called
   * by the daemon whenever agent status changes.
   */
  reconcileAgents(agents: AgentState[]): void {
    this.sessions.reconcileAgents(agents)
  }
}
