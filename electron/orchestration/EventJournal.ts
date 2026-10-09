import { randomUUID } from 'crypto'
import type { OrchestrationEvent, OrchestrationEventType } from '@shared/types'

export interface JournalEventInput {
  type: OrchestrationEventType
  groupId?: string | null
  sessionId?: string | null
  taskId?: string | null
  source?: string
  evidence?: string
}

/**
 * Append-only, monotonic event journal for orchestration state changes.
 *
 * Events are the single source of truth for the UI and for Manager queries, so
 * a Manager reads "recent checkpoint + confirmed task events + the terminal
 * fragment it needs" instead of polling the PTY at high frequency. Sequence
 * numbers are monotonically increasing; restart durability is handled by
 * {@link OrchestrationStore}, which re-hydrates the journal and restores the
 * sequence counter.
 */
export class EventJournal {
  private events: OrchestrationEvent[] = []
  private nextSequence = 1
  private persist: ((event: OrchestrationEvent) => void) | null = null

  /** Register a durable sink (the store's JSONL appender). */
  setPersistence(fn: (event: OrchestrationEvent) => void): void {
    this.persist = fn
  }

  /** Re-hydrate the journal (e.g. after daemon restart). */
  hydrate(events: OrchestrationEvent[]): void {
    this.events = [...events]
    const max = events.reduce((acc, e) => Math.max(acc, e.sequence), 0)
    this.nextSequence = max + 1
  }

  append(input: JournalEventInput): OrchestrationEvent {
    const event: OrchestrationEvent = {
      eventId: randomUUID(),
      type: input.type,
      groupId: input.groupId ?? null,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      occurredAt: new Date().toISOString(),
      source: input.source ?? 'hydra-core',
      evidence: input.evidence,
      sequence: this.nextSequence++
    }
    this.events.push(event)
    this.persist?.(event)
    return event
  }

  /** All events in order. */
  list(): OrchestrationEvent[] {
    return [...this.events]
  }

  /** Events relevant to a group (or all groups when no id is given). */
  listForGroup(groupId: string | null, limit = 200): OrchestrationEvent[] {
    const filtered = groupId
      ? this.events.filter((e) => e.groupId === groupId)
      : this.events
    return filtered.slice(-limit)
  }

  /** Events relevant to a session. */
  listForSession(sessionId: string, limit = 100): OrchestrationEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId).slice(-limit)
  }

  getSequence(): number {
    return this.nextSequence
  }
}
