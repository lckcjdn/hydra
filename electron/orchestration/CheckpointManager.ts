import { randomUUID } from 'crypto'
import type { SessionCheckpoint, CaptureCheckpointPayload } from '@shared/types'
import type { OrchestrationStore } from './OrchestrationStore'
import type { EventJournal } from './EventJournal'

/**
 * A checkpoint is the fallback when quota runs out mid-task: it captures
 * completed work, next steps, decisions, and safe Git metadata, so a handoff
 * never has to rely on a last LLM self-summary that may no longer be possible.
 */
export class CheckpointManager {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly journal: EventJournal
  ) {}

  list(sessionId?: string): SessionCheckpoint[] {
    const checkpoints = this.store.getCheckpoints()
    return sessionId ? checkpoints.filter((c) => c.sessionId === sessionId) : checkpoints
  }

  get(checkpointId: string): SessionCheckpoint | null {
    return this.store.getCheckpoints().find((c) => c.id === checkpointId) ?? null
  }

  latestForSession(sessionId: string): SessionCheckpoint | null {
    const checkpoints = this.store
      .getCheckpoints()
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    return checkpoints[checkpoints.length - 1] ?? null
  }

  capture(payload: CaptureCheckpointPayload): SessionCheckpoint {
    if (!this.store.getSessions().some((s) => s.id === payload.sessionId)) {
      throw new Error(`Session not found: ${payload.sessionId}`)
    }

    const checkpoint: SessionCheckpoint = {
      id: randomUUID(),
      sessionId: payload.sessionId,
      taskId: payload.taskId ?? null,
      completed: [...(payload.completed ?? [])],
      nextSteps: [...(payload.nextSteps ?? [])],
      decisions: [...(payload.decisions ?? [])],
      gitBaseCommit: payload.gitBaseCommit ?? null,
      branch: payload.branch ?? null,
      dirtyPaths: [...(payload.dirtyPaths ?? [])],
      artifacts: [...(payload.artifacts ?? [])],
      capturedAt: new Date().toISOString()
    }

    const checkpoints = [...this.store.getCheckpoints(), checkpoint]
    const sessions = this.store.getSessions().map((s) =>
      s.id === payload.sessionId ? { ...s, checkpointId: checkpoint.id } : s
    )
    this.store.update({ checkpoints, sessions })

    const session = this.store.getSessions().find((s) => s.id === payload.sessionId)
    this.journal.append({
      type: 'checkpoint.created',
      groupId: session?.groupId ?? null,
      sessionId: payload.sessionId,
      taskId: checkpoint.taskId,
      source: 'checkpoint-manager',
      evidence: `checkpoint ${checkpoint.id}`
    })
    return checkpoint
  }
}
