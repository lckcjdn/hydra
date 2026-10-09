import { useCallback, useEffect, useState } from 'react'
import type {
  OrchestrationSnapshot,
  CreateGroupPayload,
  AddSessionToGroupPayload,
  CreateTaskPayload,
  ReportProgressPayload,
  CaptureCheckpointPayload,
  QuotaMarkPayload,
  HandoffPreparePayload,
  HandoffSyncBackPayload
} from '@shared/types'

/**
 * Loads and keeps in sync the orchestration snapshot (Agent Groups → sessions,
 * tasks, quota pools, checkpoints, handoffs). The daemon broadcasts a fresh
 * snapshot after every mutation, so this hook never has to poll.
 */
export function useOrchestration() {
  const [snapshot, setSnapshot] = useState<OrchestrationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const next = await window.hydra.getOrchestrationState()
        if (!cancelled) {
          setSnapshot(next)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const unsubscribe = window.hydra.onOrchestrationChange((next) => {
      if (!cancelled) {
        setSnapshot(next)
        setError(null)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await window.hydra.getOrchestrationState()
      setSnapshot(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const createGroup = useCallback(async (payload: CreateGroupPayload) => {
    await window.hydra.createGroup(payload)
  }, [])

  const removeGroup = useCallback(async (groupId: string) => {
    await window.hydra.removeGroup(groupId)
  }, [])

  const addSession = useCallback(async (payload: AddSessionToGroupPayload) => {
    await window.hydra.addSessionToGroup(payload)
  }, [])

  const setManager = useCallback(async (groupId: string, sessionId: string) => {
    await window.hydra.setGroupManager(groupId, sessionId)
  }, [])

  const suspendSession = useCallback(async (sessionId: string) => {
    await window.hydra.suspendSession(sessionId)
  }, [])

  const resumeSession = useCallback(async (sessionId: string) => {
    await window.hydra.resumeSession(sessionId)
  }, [])

  const createTask = useCallback(async (payload: CreateTaskPayload) => {
    await window.hydra.createOrchTask(payload)
  }, [])

  const assignTask = useCallback(async (taskId: string, sessionId: string) => {
    await window.hydra.assignTask(taskId, sessionId)
  }, [])

  const reportProgress = useCallback(async (taskId: string, payload: Omit<ReportProgressPayload, 'taskId'>) => {
    await window.hydra.reportTaskProgress(taskId, payload)
  }, [])

  const captureCheckpoint = useCallback(async (payload: CaptureCheckpointPayload) => {
    await window.hydra.captureCheckpoint(payload)
  }, [])

  const markQuota = useCallback(async (payload: QuotaMarkPayload) => {
    await window.hydra.markQuota(payload)
  }, [])

  const prepareHandoff = useCallback(async (payload: HandoffPreparePayload) => {
    await window.hydra.prepareHandoff(payload)
  }, [])

  const acceptHandoff = useCallback(async (handoffId: string, toSessionId: string) => {
    await window.hydra.acceptHandoff(handoffId, toSessionId)
  }, [])

  const completeHandoff = useCallback(async (handoffId: string, artifacts?: string[]) => {
    await window.hydra.completeHandoff(handoffId, { artifacts })
  }, [])

  const syncBackHandoff = useCallback(async (handoffId: string, payload: Omit<HandoffSyncBackPayload, 'handoffId'>) => {
    await window.hydra.syncBackHandoff(handoffId, payload)
  }, [])

  return {
    snapshot,
    loading,
    error,
    refresh,
    createGroup,
    removeGroup,
    addSession,
    setManager,
    suspendSession,
    resumeSession,
    createTask,
    assignTask,
    reportProgress,
    captureCheckpoint,
    markQuota,
    prepareHandoff,
    acceptHandoff,
    completeHandoff,
    syncBackHandoff
  }
}
