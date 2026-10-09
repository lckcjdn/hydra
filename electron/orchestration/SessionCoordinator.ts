import { randomUUID } from 'crypto'
import type {
  AgentState,
  AddSessionToGroupPayload,
  HarnessSession,
  SessionLifecycle
} from '@shared/types'
import type { OrchestrationStore } from './OrchestrationStore'
import type { EventJournal } from './EventJournal'

const WRITER_LIFECYCLES: SessionLifecycle[] = ['starting', 'ready', 'busy', 'resume_pending']

/**
 * Coordinates Harness sessions *outside* their native process. Hydra never
 * rewrites a provider's private conversation: it persists the native session
 * id, cwd and project ref so the provider's own `resume` works unchanged.
 */
export class SessionCoordinator {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly journal: EventJournal
  ) {}

  list(): HarnessSession[] {
    return this.store.getSessions()
  }

  get(sessionId: string): HarnessSession | null {
    return this.store.getSessions().find((s) => s.id === sessionId) ?? null
  }

  findByAgentId(agentId: string): HarnessSession | null {
    return this.store.getSessions().find((s) => s.agentId === agentId) ?? null
  }

  findByNativeSession(nativeSessionId: string, provider?: string): HarnessSession | null {
    return (
      this.store
        .getSessions()
        .find((s) => s.nativeSessionId === nativeSessionId && (!provider || s.provider === provider)) ?? null
    )
  }

  register(payload: AddSessionToGroupPayload): HarnessSession {
    if (!payload.cwd) throw new Error('Session cwd is required')
    if (!payload.projectRef) throw new Error('Session projectRef is required')

    const now = new Date().toISOString()
    const session: HarnessSession = {
      id: randomUUID(),
      provider: payload.provider,
      nativeSessionId: payload.nativeSessionId ?? null,
      cwd: payload.cwd,
      projectRef: payload.projectRef,
      groupId: payload.groupId,
      role: payload.role,
      quotaPoolId: payload.quotaPoolId ?? null,
      lifecycle: 'registered',
      currentTaskId: null,
      checkpointId: null,
      agentId: payload.agentId ?? null,
      createdAt: now,
      updatedAt: now
    }

    this.store.update({ sessions: [...this.store.getSessions(), session] })
    this.journal.append({
      type: 'session.registered',
      groupId: session.groupId,
      sessionId: session.id,
      source: 'session-coordinator',
      evidence: `provider=${session.provider} role=${session.role} cwd=${session.cwd}`
    })
    return session
  }

  setLifecycle(sessionId: string, lifecycle: SessionLifecycle): HarnessSession {
    const session = this.require(sessionId)
    const next: HarnessSession = { ...session, lifecycle, updatedAt: new Date().toISOString() }
    this.store.update({
      sessions: this.store.getSessions().map((s) => (s.id === sessionId ? next : s))
    })

    const eventType =
      lifecycle === 'suspended'
        ? ('session.suspended' as const)
        : lifecycle === 'resume_pending'
          ? ('session.resumed' as const)
          : lifecycle === 'ready'
            ? ('session.started' as const)
            : ('session.waiting' as const)
    this.journal.append({
      type: eventType,
      groupId: next.groupId,
      sessionId: next.id,
      source: 'session-coordinator',
      evidence: `lifecycle → ${lifecycle}`
    })
    return next
  }

  suspend(sessionId: string): HarnessSession {
    return this.setLifecycle(sessionId, 'suspended')
  }

  resume(sessionId: string): HarnessSession {
    const session = this.require(sessionId)
    // A resumed session is not guaranteed usable until the provider validates
    // it; `resume_pending` is the honest pre-validation state.
    return this.setLifecycle(sessionId, session.lifecycle === 'suspended' ? 'resume_pending' : session.lifecycle)
  }

  linkAgent(sessionId: string, agentId: string | null): HarnessSession {
    const session = this.require(sessionId)
    const next: HarnessSession = { ...session, agentId, updatedAt: new Date().toISOString() }
    this.store.update({
      sessions: this.store.getSessions().map((s) => (s.id === sessionId ? next : s))
    })
    return next
  }

  /** Attach (or update) a native session id when the provider announces it. */
  setNativeSessionId(sessionId: string, nativeSessionId: string): HarnessSession {
    const session = this.require(sessionId)
    const next: HarnessSession = { ...session, nativeSessionId, updatedAt: new Date().toISOString() }
    this.store.update({
      sessions: this.store.getSessions().map((s) => (s.id === sessionId ? next : s))
    })
    return next
  }

  /**
   * Return sessions that are actively writing to the given cwd, excluding one
   * session id. Two write workers must never silently overwrite the same
   * directory — the caller surfaces the conflict instead.
   */
  findConflictingWriters(cwd: string, excludeSessionId?: string): HarnessSession[] {
    return this.store.getSessions().filter(
      (s) =>
        s.cwd === cwd &&
        s.id !== excludeSessionId &&
        WRITER_LIFECYCLES.includes(s.lifecycle)
    )
  }

  /**
   * Reconcile orchestration session lifecycles from live Hydra agent states.
   * Only sessions that are actually linked to an AgentState are updated; this
   * is how `busy` vs `ready` stays honest without polling provider internals.
   */
  reconcileAgents(agents: AgentState[]): void {
    const byAgentId = new Map(agents.map((a) => [a.id, a]))
    const sessions = this.store.getSessions()
    let changed = false

    const next = sessions.map((s) => {
      if (!s.agentId) return s
      const agent = byAgentId.get(s.agentId)
      if (!agent) return s

      const lifecycle: SessionLifecycle =
        agent.status === 'running'
          ? 'busy'
          : agent.status === 'starting'
            ? 'starting'
            : agent.status === 'errored'
              ? 'errored'
              : 'ready'

      if (lifecycle === s.lifecycle) return s
      changed = true
      return { ...s, lifecycle, updatedAt: new Date().toISOString() }
    })

    if (changed) this.store.update({ sessions: next })
  }

  private require(sessionId: string): HarnessSession {
    const session = this.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }
}
