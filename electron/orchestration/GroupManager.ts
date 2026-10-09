import { randomUUID } from 'crypto'
import type { AgentGroup, HarnessSession, CreateGroupPayload } from '@shared/types'
import type { OrchestrationStore } from './OrchestrationStore'
import type { EventJournal } from './EventJournal'

/**
 * Groups are long-lived logical containers. V1 allows a single `parentGroupId`
 * reference but forbids cycles; multi-level nesting and per-level scheduling
 * authority are deferred to V3 (see the plan §2).
 */
export class GroupManager {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly journal: EventJournal
  ) {}

  list(): AgentGroup[] {
    return this.store.getGroups()
  }

  get(groupId: string): AgentGroup | null {
    return this.store.getGroups().find((g) => g.id === groupId) ?? null
  }

  create(payload: CreateGroupPayload): AgentGroup {
    const name = payload.name.trim()
    if (!name) throw new Error('Group name is required')

    const now = new Date().toISOString()
    const group: AgentGroup = {
      id: randomUUID(),
      name,
      managerSessionId: null,
      sessionIds: [],
      projectRefs: [...(payload.projectRefs ?? [])],
      parentGroupId: payload.parentGroupId ?? null,
      orchestrationPolicyId: 'default-v1',
      createdAt: now,
      updatedAt: now
    }

    if (group.parentGroupId && !this.get(group.parentGroupId)) {
      throw new Error(`Parent group not found: ${group.parentGroupId}`)
    }
    if (group.parentGroupId && this.wouldCreateCycle(group.id, group.parentGroupId)) {
      throw new Error('Parent group would create a cycle')
    }

    this.store.update({ groups: [...this.store.getGroups(), group] })
    this.journal.append({ type: 'group.created', groupId: group.id, source: 'group-manager' })
    return group
  }

  remove(groupId: string): boolean {
    const groups = this.store.getGroups()
    const next = groups.filter((g) => g.id !== groupId)
    if (next.length === groups.length) return false
    this.store.update({ groups: next })
    return true
  }

  addSession(groupId: string, sessionId: string): AgentGroup {
    const group = this.require(groupId)
    const sessions = this.store.getSessions()
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (session.groupId && session.groupId !== groupId) {
      throw new Error(`Session ${sessionId} already belongs to group ${session.groupId}`)
    }

    if (!group.sessionIds.includes(sessionId)) {
      this.store.update({
        groups: this.store.getGroups().map((g) =>
          g.id === groupId
            ? { ...g, sessionIds: [...g.sessionIds, sessionId], updatedAt: new Date().toISOString() }
            : g
        )
      })
    }

    if (session.groupId !== groupId) {
      this.store.update({
        sessions: sessions.map((s) => (s.id === sessionId ? { ...s, groupId } : s))
      })
    }

    this.journal.append({
      type: 'group.updated',
      groupId,
      sessionId,
      source: 'group-manager',
      evidence: `session ${sessionId} added to group`
    })
    return this.get(groupId)!
  }

  setManager(groupId: string, sessionId: string): AgentGroup {
    const group = this.require(groupId)
    const sessions = this.store.getSessions()
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (session.groupId !== groupId) {
      throw new Error(`Session ${sessionId} is not a member of group ${groupId}`)
    }
    if (session.role !== 'manager' && session.role !== 'planner') {
      throw new Error(`Session ${sessionId} has role ${session.role}; a manager must be manager/planner`)
    }

    const next: AgentGroup = { ...group, managerSessionId: sessionId, updatedAt: new Date().toISOString() }
    this.store.update({
      groups: this.store.getGroups().map((g) => (g.id === groupId ? next : g))
    })
    this.journal.append({ type: 'group.updated', groupId, sessionId, source: 'group-manager', evidence: 'manager assigned' })
    return next
  }

  members(groupId: string): HarnessSession[] {
    const group = this.get(groupId)
    if (!group) return []
    const byId = new Map(this.store.getSessions().map((s) => [s.id, s]))
    return group.sessionIds.map((id) => byId.get(id)).filter((s): s is HarnessSession => !!s)
  }

  private require(groupId: string): AgentGroup {
    const group = this.get(groupId)
    if (!group) throw new Error(`Group not found: ${groupId}`)
    return group
  }

  private wouldCreateCycle(groupId: string, parentId: string): boolean {
    let cursor: string | null = parentId
    const seen = new Set<string>()
    while (cursor) {
      if (cursor === groupId) return true
      if (seen.has(cursor)) return true
      seen.add(cursor)
      cursor = this.get(cursor)?.parentGroupId ?? null
    }
    return false
  }
}
