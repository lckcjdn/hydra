import { randomUUID } from 'crypto'
import type {
  HandoffRecord,
  HandoffPreparePayload,
  HandoffAcceptPayload,
  HandoffCompletePayload,
  HandoffSyncBackPayload
} from '@shared/types'
import type { OrchestrationStore } from './OrchestrationStore'
import type { EventJournal } from './EventJournal'

/**
 * Handoff moves an *explicit deliverable* (goal, constraints, completed work,
 * patch/artifact locations, acceptance criteria) to another Harness. It never
 * imports a provider's private session format, and it never forces preemption
 * of an almost-finished task back to the original session.
 */
export class HandoffManager {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly journal: EventJournal
  ) {}

  list(groupId?: string): HandoffRecord[] {
    const handoffs = this.store.getHandoffs()
    return groupId ? handoffs.filter((h) => h.groupId === groupId) : handoffs
  }

  get(handoffId: string): HandoffRecord | null {
    return this.store.getHandoffs().find((h) => h.id === handoffId) ?? null
  }

  prepare(payload: HandoffPreparePayload): HandoffRecord {
    const task = this.store.getTasks().find((t) => t.id === payload.taskId)
    if (!task) throw new Error(`Task not found: ${payload.taskId}`)
    const from = this.store.getSessions().find((s) => s.id === payload.fromSessionId)
    if (!from) throw new Error(`Session not found: ${payload.fromSessionId}`)

    const handoff: HandoffRecord = {
      id: randomUUID(),
      groupId: task.groupId,
      taskId: task.id,
      fromSessionId: from.id,
      toSessionId: null,
      state: 'prepared',
      materials: [...(payload.materials ?? [])],
      syncBackSummary: null,
      createdAt: new Date().toISOString(),
      acceptedAt: null,
      completedAt: null
    }

    this.store.update({ handoffs: [...this.store.getHandoffs(), handoff] })
    this.store.update({
      tasks: this.store.getTasks().map((t) => (t.id === task.id ? { ...t, state: 'handoff' as const } : t))
    })
    this.journal.append({
      type: 'handoff.requested',
      groupId: task.groupId,
      sessionId: from.id,
      taskId: task.id,
      source: 'handoff-manager',
      evidence: `handoff ${handoff.id} prepared`
    })
    return handoff
  }

  accept(payload: HandoffAcceptPayload): HandoffRecord {
    const handoff = this.require(payload.handoffId)
    const to = this.store.getSessions().find((s) => s.id === payload.toSessionId)
    if (!to) throw new Error(`Session not found: ${payload.toSessionId}`)
    if (to.id === handoff.fromSessionId) {
      throw new Error('Cannot hand a task back to the same session')
    }

    const next: HandoffRecord = {
      ...handoff,
      toSessionId: to.id,
      state: 'accepted',
      acceptedAt: new Date().toISOString()
    }
    this.store.update({ handoffs: this.store.getHandoffs().map((h) => (h.id === handoff.id ? next : h)) })
    this.store.update({
      tasks: this.store.getTasks().map((t) =>
        t.id === handoff.taskId ? { ...t, assigneeSessionId: to.id, state: 'active' as const } : t
      )
    })
    this.journal.append({
      type: 'handoff.accepted',
      groupId: handoff.groupId,
      sessionId: to.id,
      taskId: handoff.taskId,
      source: 'handoff-manager',
      evidence: `handoff ${handoff.id} accepted by ${to.id}`
    })
    return next
  }

  complete(payload: HandoffCompletePayload): HandoffRecord {
    const handoff = this.require(payload.handoffId)
    const next: HandoffRecord = {
      ...handoff,
      state: 'completed',
      completedAt: new Date().toISOString(),
      materials: [...new Set([...handoff.materials, ...(payload.artifacts ?? [])])]
    }
    this.store.update({ handoffs: this.store.getHandoffs().map((h) => (h.id === handoff.id ? next : h)) })
    this.journal.append({
      type: 'handoff.completed',
      groupId: handoff.groupId,
      sessionId: handoff.toSessionId,
      taskId: handoff.taskId,
      source: 'handoff-manager'
    })
    return next
  }

  syncBack(payload: HandoffSyncBackPayload): HandoffRecord {
    const handoff = this.require(payload.handoffId)
    const next: HandoffRecord = {
      ...handoff,
      state: 'synced_back',
      syncBackSummary: payload.summary
    }
    this.store.update({ handoffs: this.store.getHandoffs().map((h) => (h.id === handoff.id ? next : h)) })
    this.journal.append({
      type: 'handoff.synced_back',
      groupId: handoff.groupId,
      sessionId: handoff.fromSessionId,
      taskId: handoff.taskId,
      source: 'handoff-manager',
      evidence: payload.summary
    })
    return next
  }

  private require(handoffId: string): HandoffRecord {
    const handoff = this.get(handoffId)
    if (!handoff) throw new Error(`Handoff not found: ${handoffId}`)
    return handoff
  }
}
