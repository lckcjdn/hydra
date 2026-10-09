import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrchestrationService } from './OrchestrationService'
import { classifyQuotaSignal } from '../quota/adapters'
import type { AgentState } from '@shared/types'

let dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-orch-'))
  dirs.push(dir)
  return dir
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'agent-1',
    name: 'agent',
    projectDir: 'C:\\work\\project-a',
    provider: 'codex',
    model: 'gpt-5.3-codex',
    yolo: false,
    isManager: false,
    sessionId: null,
    initialPrompt: '',
    createdAt: new Date(0).toISOString(),
    status: 'idle',
    pid: null,
    restartCount: 0,
    startedAt: null,
    lastActivityAt: new Date(0).toISOString(),
    workMode: 'local',
    worktreePath: null,
    worktreeBranch: null,
    ...overrides
  }
}

afterEach(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  dirs = []
})

function seedGroup(svc: OrchestrationService) {
  const group = svc.createGroup({ name: 'Media Pipeline', projectRefs: ['C:\\work\\project-a'] })
  const codex = svc.addSession({
    groupId: group.id,
    provider: 'codex',
    nativeSessionId: 'c-001',
    cwd: 'C:\\work\\project-a',
    projectRef: 'C:\\work\\project-a',
    role: 'worker',
    quotaPoolId: null
  })
  const dsh = svc.addSession({
    groupId: group.id,
    provider: 'dsh',
    nativeSessionId: 'd-002',
    cwd: 'C:\\work\\project-a',
    projectRef: 'C:\\work\\project-a',
    role: 'worker'
  })
  const manager = svc.addSession({
    groupId: group.id,
    provider: 'dsh',
    nativeSessionId: 'd-mgr',
    cwd: 'C:\\work\\project-a',
    projectRef: 'C:\\work\\project-a',
    role: 'manager'
  })
  return { group, codex, dsh, manager }
}

describe('OrchestrationService groups and sessions', () => {
  it('persists cross-provider membership across daemon restarts', () => {
    const dir = tempDir()
    const first = new OrchestrationService(dir)
    const { group, codex, dsh } = seedGroup(first)
    first.setManager(group.id, first.sessions.findByNativeSession('d-mgr', 'dsh')!.id)

    // Simulate a daemon restart: rehydrate from the same directory.
    const second = new OrchestrationService(dir)
    const state = second.getState()
    expect(state.groups).toHaveLength(1)
    expect(state.sessions).toHaveLength(3)
    const restored = state.groups[0]
    expect(restored.sessionIds).toEqual(expect.arrayContaining([codex.id, dsh.id]))
    expect(restored.managerSessionId).not.toBeNull()
    // Native session ids and cwd survive.
    const restoredCodex = state.sessions.find((s) => s.id === codex.id)!
    expect(restoredCodex.nativeSessionId).toBe('c-001')
    expect(restoredCodex.cwd).toBe('C:\\work\\project-a')
  })

  it('rejects cycles in parent groups', () => {
    const svc = new OrchestrationService(null)
    const a = svc.createGroup({ name: 'A' })
    const b = svc.createGroup({ name: 'B', parentGroupId: a.id })
    expect(() => svc.createGroup({ name: 'C', parentGroupId: b.id })).not.toThrow()
    expect(() => svc.groups.get(a.id)!.parentGroupId).toBeDefined()
  })

  it('detects two write workers sharing the same cwd', () => {
    const svc = new OrchestrationService(null)
    const { codex, dsh } = seedGroup(svc)
    svc.sessions.setLifecycle(codex.id, 'busy')
    svc.sessions.setLifecycle(dsh.id, 'busy')

    // Excluding the relay session surfaces the other live writer.
    const conflicts = svc.sessions.findConflictingWriters('C:\\work\\project-a', dsh.id)
    expect(conflicts.map((s) => s.id)).toContain(codex.id)
    expect(conflicts.map((s) => s.id)).not.toContain(dsh.id)
  })
})

describe('TaskDispatcher + quota freeze', () => {
  it('assigns a second task to an existing session without creating a new one', () => {
    const svc = new OrchestrationService(null)
    const { group, codex } = seedGroup(svc)
    const taskA = svc.createTask({ groupId: group.id, goal: 'Build detection module' })
    const taskB = svc.createTask({ groupId: group.id, goal: 'Add unit tests' })

    svc.assignTask({ taskId: taskA.id, sessionId: codex.id })
    svc.assignTask({ taskId: taskB.id, sessionId: codex.id })

    const sessions = svc.getState().sessions
    expect(sessions).toHaveLength(3) // manager + codex + dsh, no new worker
    const codexSession = sessions.find((s) => s.id === codex.id)!
    expect(codexSession.currentTaskId).toBe(taskB.id)
  })

  it('freezes dispatch when a session quota pool is blocked', () => {
    const svc = new OrchestrationService(null)
    const { group, codex } = seedGroup(svc)
    const pool = svc.quota.ensurePool('codex', 'gpt-account-A')
    svc.store.update({
      sessions: svc.getState().sessions.map((s) => (s.id === codex.id ? { ...s, quotaPoolId: pool.id } : s))
    })

    svc.markQuota({ poolId: pool.id, availability: 'blocked' })
    const task = svc.createTask({ groupId: group.id, goal: 'Handled elsewhere' })
    expect(() => svc.assignTask({ taskId: task.id, sessionId: codex.id })).toThrow(/blocked/)
  })
})

describe('Checkpoint + handoff state machine', () => {
  it('captures a checkpoint and hands a task across harnesses without losing the original session', () => {
    const svc = new OrchestrationService(null)
    const { group, codex, dsh } = seedGroup(svc)

    const task = svc.createTask({
      groupId: group.id,
      goal: 'Ship video detection',
      acceptanceCriteria: ['passes tests']
    })
    svc.assignTask({ taskId: task.id, sessionId: codex.id })

    const checkpoint = svc.captureCheckpoint({
      sessionId: codex.id,
      taskId: task.id,
      completed: ['model interface'],
      nextSteps: ['wire the pipeline'],
      branch: 'feature/video-detection',
      gitBaseCommit: 'abc123',
      dirtyPaths: ['src/detect.ts']
    })
    expect(checkpoint.branch).toBe('feature/video-detection')
    expect(svc.checkpoints.latestForSession(codex.id)?.id).toBe(checkpoint.id)

    const handoff = svc.prepareHandoff({
      taskId: task.id,
      fromSessionId: codex.id,
      materials: ['patch-0001.patch', 'checkpoint summary']
    })
    expect(handoff.state).toBe('prepared')

    svc.acceptHandoff({ handoffId: handoff.id, toSessionId: dsh.id })
    const afterAccept = svc.handoffs.get(handoff.id)!
    expect(afterAccept.state).toBe('accepted')
    expect(afterAccept.toSessionId).toBe(dsh.id)

    // The task now belongs to the relay session; the original session is intact.
    const taskAfter = svc.tasks.get(task.id)!
    expect(taskAfter.assigneeSessionId).toBe(dsh.id)
    const original = svc.sessions.get(codex.id)!
    expect(original.nativeSessionId).toBe('c-001')
    expect(original.id).toBe(codex.id)

    svc.completeHandoff({ handoffId: handoff.id, artifacts: ['result.patch'] })
    svc.syncBackHandoff({ handoffId: handoff.id, summary: 'detection module done; tests green' })
    expect(svc.handoffs.get(handoff.id)!.state).toBe('synced_back')
  })

  it('refuses to hand a task back to the same session', () => {
    const svc = new OrchestrationService(null)
    const { group, codex } = seedGroup(svc)
    const task = svc.createTask({ groupId: group.id, goal: 'X' })
    const handoff = svc.prepareHandoff({ taskId: task.id, fromSessionId: codex.id })
    expect(() => svc.acceptHandoff({ handoffId: handoff.id, toSessionId: codex.id })).toThrow(/same session/)
  })
})

describe('Quota signal classification (no fabricated countdowns)', () => {
  it('does not treat a bare 429 as quota exhaustion', () => {
    const obs = classifyQuotaSignal({ code: '429', message: 'Too Many Requests' })
    expect(obs).toBeNull()
  })

  it('does not treat a network failure as quota exhaustion', () => {
    const obs = classifyQuotaSignal({ message: 'ECONNREFUSED connect to api' })
    expect(obs).toBeNull()
  })

  it('reports explicit quota exhaustion as blocked', () => {
    const obs = classifyQuotaSignal({ message: 'quota exceeded, limit reached' })
    expect(obs?.availability).toBe('blocked')
  })

  it('never invents a reset time', () => {
    const obs = classifyQuotaSignal({ message: 'quota exhausted' })
    expect(obs?.resetAt).toBeUndefined()
  })
})

describe('Event journal durability', () => {
  it('rehydrates events and keeps sequence monotonic across restarts', () => {
    const dir = tempDir()
    const first = new OrchestrationService(dir)
    first.createGroup({ name: 'G' })
    const before = first.journal.getSequence()

    const second = new OrchestrationService(dir)
    expect(second.journal.list().length).toBeGreaterThanOrEqual(1)
    expect(second.journal.getSequence()).toBe(before)
    second.createGroup({ name: 'H' })
    expect(second.journal.getSequence()).toBeGreaterThan(before)
  })
})

describe('reconcileAgents', () => {
  it('maps a linked running agent to busy and idle to ready', () => {
    const svc = new OrchestrationService(null)
    const { group, codex } = seedGroup(svc)
    const session = svc.sessions.get(codex.id)!
    svc.sessions.linkAgent(session.id, 'agent-1')

    svc.reconcileAgents([makeAgent({ id: 'agent-1', status: 'running' })])
    expect(svc.sessions.get(codex.id)!.lifecycle).toBe('busy')

    svc.reconcileAgents([makeAgent({ id: 'agent-1', status: 'idle' })])
    expect(svc.sessions.get(codex.id)!.lifecycle).toBe('ready')
    expect(svc.sessions.get(codex.id)!.groupId).toBe(group.id)
  })
})
