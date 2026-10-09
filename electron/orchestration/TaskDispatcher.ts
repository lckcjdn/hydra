import { randomUUID } from 'crypto'
import type {
  TaskAssignment,
  TaskState,
  CreateTaskPayload,
  AssignTaskPayload,
  ReportProgressPayload
} from '@shared/types'
import type { OrchestrationStore } from './OrchestrationStore'
import type { EventJournal } from './EventJournal'
import type { QuotaManager } from '../quota/QuotaManager'

/**
 * A Task is a work goal + acceptance criteria, not a single LLM call. One
 * session can carry several tasks in sequence, and dispatching to an existing
 * session must never silently spawn a new one.
 */
export class TaskDispatcher {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly journal: EventJournal,
    private readonly quota: QuotaManager
  ) {}

  list(groupId?: string): TaskAssignment[] {
    const tasks = this.store.getTasks()
    return groupId ? tasks.filter((t) => t.groupId === groupId) : tasks
  }

  get(taskId: string): TaskAssignment | null {
    return this.store.getTasks().find((t) => t.id === taskId) ?? null
  }

  create(payload: CreateTaskPayload): TaskAssignment {
    if (!payload.groupId) throw new Error('Task groupId is required')
    const goal = payload.goal.trim()
    if (!goal) throw new Error('Task goal is required')

    const now = new Date().toISOString()
    const task: TaskAssignment = {
      id: randomUUID(),
      groupId: payload.groupId,
      assigneeSessionId: null,
      goal,
      acceptanceCriteria: [...(payload.acceptanceCriteria ?? [])],
      state: 'queued',
      artifacts: [],
      createdAt: now,
      updatedAt: now
    }
    this.store.update({ tasks: [...this.store.getTasks(), task] })
    return task
  }

  assign(payload: AssignTaskPayload): TaskAssignment {
    const task = this.require(payload.taskId)
    const sessions = this.store.getSessions()
    const session = sessions.find((s) => s.id === payload.sessionId)
    if (!session) throw new Error(`Session not found: ${payload.sessionId}`)
    if (task.groupId !== session.groupId) {
      throw new Error('Task and session must belong to the same group')
    }
    if (session.role === 'planner') {
      throw new Error('A planner session does not own worker tasks')
    }
    if (this.quota.isBlocked(session.quotaPoolId)) {
      throw new Error(`Cannot assign task: session ${session.id} quota pool is blocked`)
    }

    const next: TaskAssignment = {
      ...task,
      assigneeSessionId: session.id,
      state: 'assigned',
      updatedAt: new Date().toISOString()
    }
    this.store.update({ tasks: this.store.getTasks().map((t) => (t.id === task.id ? next : t)) })

    this.journal.append({
      type: 'task.assigned',
      groupId: task.groupId,
      sessionId: session.id,
      taskId: task.id,
      source: 'task-dispatcher',
      evidence: `task assigned to ${session.id}`
    })
    return next
  }

  reportProgress(payload: ReportProgressPayload): TaskAssignment {
    const task = this.require(payload.taskId)
    if (task.state === 'done') return task

    const next: TaskAssignment = {
      ...task,
      state: task.state === 'queued' ? 'active' : task.state,
      artifacts: [...new Set([...task.artifacts, ...(payload.artifacts ?? [])])],
      updatedAt: new Date().toISOString()
    }
    this.store.update({ tasks: this.store.getTasks().map((t) => (t.id === task.id ? next : t)) })

    this.journal.append({
      type: 'task.progress_reported',
      groupId: task.groupId,
      sessionId: task.assigneeSessionId,
      taskId: task.id,
      source: 'task-dispatcher',
      evidence: payload.note
    })
    return next
  }

  setState(taskId: string, state: TaskState): TaskAssignment {
    const task = this.require(taskId)
    const next: TaskAssignment = { ...task, state, updatedAt: new Date().toISOString() }
    this.store.update({ tasks: this.store.getTasks().map((t) => (t.id === taskId ? next : t)) })

    const eventType =
      state === 'blocked'
        ? ('task.blocked' as const)
        : state === 'review'
          ? ('task.review_requested' as const)
          : state === 'done'
            ? ('task.done' as const)
            : null
    if (eventType) {
      this.journal.append({
        type: eventType,
        groupId: task.groupId,
        sessionId: task.assigneeSessionId,
        taskId: task.id,
        source: 'task-dispatcher'
      })
    }
    return next
  }

  private require(taskId: string): TaskAssignment {
    const task = this.get(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    return task
  }
}
