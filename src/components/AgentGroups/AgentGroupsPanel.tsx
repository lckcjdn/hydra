import { useState } from 'react'
import { useOrchestration } from '../../hooks/useOrchestration'
import type { OrchestrationGroupSummary, ProviderId, SessionRole, TaskAssignment, CreateGroupPayload } from '@shared/types'
import styles from './AgentGroupsPanel.module.css'

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'opencode', 'dsh']
const ROLES: SessionRole[] = ['manager', 'planner', 'worker']

function ProviderLabel(provider: ProviderId): string {
  return provider === 'dsh' ? 'DSH' : provider === 'opencode' ? 'OpenCode' : provider === 'codex' ? 'Codex' : 'Claude'
}

interface NewGroupFormProps {
  onCreate: (payload: CreateGroupPayload) => Promise<void>
}

function NewGroupForm({ onCreate }: NewGroupFormProps) {
  const [name, setName] = useState('')
  const [refs, setRefs] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className={styles.newGroupForm}>
      <input
        className={styles.input}
        placeholder="Group name (e.g. Media Pipeline)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={styles.input}
        placeholder="Project refs (comma-separated dirs, optional)"
        value={refs}
        onChange={(e) => setRefs(e.target.value)}
      />
      <button
        className={styles.primaryBtn}
        disabled={!name.trim() || busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onCreate({
              name: name.trim(),
              projectRefs: refs.split(',').map((r) => r.trim()).filter(Boolean)
            })
            setName('')
            setRefs('')
          } finally {
            setBusy(false)
          }
        }}
      >
        Create Group
      </button>
    </div>
  )
}

interface AddSessionFormProps {
  groupId: string
  onAdd: (payload: {
    groupId: string
    provider: ProviderId
    cwd: string
    projectRef: string
    role: SessionRole
    nativeSessionId: string
  }) => Promise<void>
}

function AddSessionForm({ groupId, onAdd }: AddSessionFormProps) {
  const [provider, setProvider] = useState<ProviderId>('codex')
  const [cwd, setCwd] = useState('')
  const [role, setRole] = useState<SessionRole>('worker')
  const [nativeId, setNativeId] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className={styles.inlineForm}>
      <select className={styles.select} value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>{ProviderLabel(p)}</option>
        ))}
      </select>
      <select className={styles.select} value={role} onChange={(e) => setRole(e.target.value as SessionRole)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <input
        className={styles.input}
        placeholder="cwd (project dir)"
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
      />
      <input
        className={styles.input}
        placeholder="Native session id (optional)"
        value={nativeId}
        onChange={(e) => setNativeId(e.target.value)}
      />
      <button
        className={styles.primaryBtn}
        disabled={!cwd.trim() || busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onAdd({ groupId, provider, cwd: cwd.trim(), projectRef: cwd.trim(), role, nativeSessionId: nativeId.trim() })
            setCwd('')
            setNativeId('')
          } finally {
            setBusy(false)
          }
        }}
      >
        Add Session
      </button>
    </div>
  )
}

export function AgentGroupsPanel({ onClose }: { onClose: () => void }) {
  const orch = useOrchestration()
  const groups = orch.snapshot?.groups ?? []

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Agent Groups</h2>
            <p className={styles.subtitle}>
              Nested Harness Session Groups — manager/planner/worker sessions, quota pools, checkpoints and handoffs.
            </p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={styles.body}>
          <NewGroupForm onCreate={orch.createGroup} />

          {orch.loading && <div className={styles.empty}>Loading…</div>}
          {orch.error && <div className={styles.error}>{orch.error}</div>}

          {groups.length === 0 && !orch.loading && (
            <div className={styles.empty}>
              No groups yet. Create one to start orchestrating sessions across harnesses.
            </div>
          )}

          {groups.map((group) => (
            <GroupCard key={group.group.id} summary={group} orch={orch} />
          ))}
        </div>
      </div>
    </div>
  )
}

function GroupCard({ summary, orch }: { summary: OrchestrationGroupSummary; orch: ReturnType<typeof useOrchestration> }) {
  const { group, sessions, tasks, handoffs } = summary
  const workers = sessions.filter((s) => s.session.role === 'worker' || s.session.role === 'manager')
  const [taskGoal, setTaskGoal] = useState('')
  const [assignTaskId, setAssignTaskId] = useState('')
  const [assignSessionId, setAssignSessionId] = useState('')
  const [progressTaskId, setProgressTaskId] = useState('')
  const [progressNote, setProgressNote] = useState('')
  const [checkpointSessionId, setCheckpointSessionId] = useState('')
  const [checkpointNote, setCheckpointNote] = useState('')
  const [handoffTaskId, setHandoffTaskId] = useState('')
  const [handoffToSessionId, setHandoffToSessionId] = useState('')

  const openTasks = tasks.filter((t) => t.state !== 'done')

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <strong className={styles.cardTitle}>{group.name}</strong>
        <span className={styles.muted}>
          {sessions.length} session{sessions.length === 1 ? '' : 's'} · manager: {group.managerSessionId ? 'assigned' : 'none'}
        </span>
      </div>

      <AddSessionForm groupId={group.id} onAdd={orch.addSession} />

      <h4 className={styles.sectionLabel}>Sessions</h4>
      {sessions.length === 0 && <div className={styles.emptySmall}>No sessions.</div>}
      <ul className={styles.list}>
        {sessions.map(({ session, quota }) => (
          <li key={session.id} className={styles.row}>
            <span className={`${styles.badge} ${styles[`role_${session.role}`]}`}>{session.role}</span>
            <span className={styles.rowMain}>
              {ProviderLabel(session.provider)} · {session.nativeSessionId ?? 'no native id'}
              <span className={styles.muted}> · {session.cwd}</span>
            </span>
            <span className={`${styles.badge} ${styles[`lifecycle_${session.lifecycle}`]}`}>{session.lifecycle}</span>
            <span className={`${styles.badge} ${quota ? styles[`quota_${quota.availability}`] : styles.quota_unknown}`}>
              {quota ? quota.availability : 'no pool'}
            </span>
            <div className={styles.rowActions}>
              {session.lifecycle === 'suspended' ? (
                <button className={styles.miniBtn} onClick={() => void orch.resumeSession(session.id)}>Resume</button>
              ) : (
                <button className={styles.miniBtn} onClick={() => void orch.suspendSession(session.id)}>Suspend</button>
              )}
              {session.quotaPoolId && (
                <button
                  className={styles.miniBtn}
                  onClick={() => void orch.markQuota({
                    poolId: session.quotaPoolId!,
                    availability: quota?.availability === 'blocked' ? 'available' : 'blocked',
                    source: 'manual'
                  })}
                >
                  {quota?.availability === 'blocked' ? 'Unblock quota' : 'Block quota'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h4 className={styles.sectionLabel}>Tasks</h4>
      <div className={styles.inlineForm}>
        <input className={styles.input} placeholder="New task goal" value={taskGoal} onChange={(e) => setTaskGoal(e.target.value)} />
        <button
          className={styles.primaryBtn}
          disabled={!taskGoal.trim()}
          onClick={async () => {
            await orch.createTask({ groupId: group.id, goal: taskGoal.trim() })
            setTaskGoal('')
          }}
        >
          Add Task
        </button>
      </div>
      {tasks.length === 0 && <div className={styles.emptySmall}>No tasks.</div>}
      <ul className={styles.list}>
        {tasks.map((task) => (
          <li key={task.id} className={styles.row}>
            <span className={`${styles.badge} ${styles[`task_${task.state}`]}`}>{task.state}</span>
            <span className={styles.rowMain}>{task.goal}</span>
            <span className={styles.muted}>{task.assigneeSessionId ? 'assigned' : 'unassigned'}</span>
          </li>
        ))}
      </ul>
      <div className={styles.inlineForm}>
        <select className={styles.select} value={assignTaskId} onChange={(e) => setAssignTaskId(e.target.value)}>
          <option value="">Assign task…</option>
          {openTasks.map((t) => <option key={t.id} value={t.id}>{t.goal}</option>)}
        </select>
        <select className={styles.select} value={assignSessionId} onChange={(e) => setAssignSessionId(e.target.value)}>
          <option value="">to session…</option>
          {workers.map((s) => <option key={s.session.id} value={s.session.id}>{s.session.role} · {ProviderLabel(s.session.provider)}</option>)}
        </select>
        <button
          className={styles.primaryBtn}
          disabled={!assignTaskId || !assignSessionId}
          onClick={async () => {
            await orch.assignTask(assignTaskId, assignSessionId)
            setAssignTaskId('')
            setAssignSessionId('')
          }}
        >
          Assign
        </button>
      </div>
      <div className={styles.inlineForm}>
        <select className={styles.select} value={progressTaskId} onChange={(e) => setProgressTaskId(e.target.value)}>
          <option value="">Report progress…</option>
          {openTasks.map((t) => <option key={t.id} value={t.id}>{t.goal}</option>)}
        </select>
        <input className={styles.input} placeholder="note" value={progressNote} onChange={(e) => setProgressNote(e.target.value)} />
        <button
          className={styles.primaryBtn}
          disabled={!progressTaskId || !progressNote.trim()}
          onClick={async () => {
            await orch.reportProgress(progressTaskId, { note: progressNote.trim() })
            setProgressNote('')
          }}
        >
          Report
        </button>
      </div>

      <h4 className={styles.sectionLabel}>Checkpoint</h4>
      <div className={styles.inlineForm}>
        <select className={styles.select} value={checkpointSessionId} onChange={(e) => setCheckpointSessionId(e.target.value)}>
          <option value="">Session…</option>
          {sessions.map((s) => <option key={s.session.id} value={s.session.id}>{s.session.role} · {ProviderLabel(s.session.provider)}</option>)}
        </select>
        <input className={styles.input} placeholder="completed / next steps" value={checkpointNote} onChange={(e) => setCheckpointNote(e.target.value)} />
        <button
          className={styles.primaryBtn}
          disabled={!checkpointSessionId}
          onClick={async () => {
            await orch.captureCheckpoint({
              sessionId: checkpointSessionId,
              completed: checkpointNote.trim() ? [checkpointNote.trim()] : [],
              nextSteps: []
            })
            setCheckpointNote('')
          }}
        >
          Capture
        </button>
      </div>

      <h4 className={styles.sectionLabel}>Handoffs</h4>
      <div className={styles.inlineForm}>
        <select className={styles.select} value={handoffTaskId} onChange={(e) => setHandoffTaskId(e.target.value)}>
          <option value="">Task…</option>
          {openTasks.map((t) => <option key={t.id} value={t.id}>{t.goal}</option>)}
        </select>
        <select className={styles.select} value={handoffToSessionId} onChange={(e) => setHandoffToSessionId(e.target.value)}>
          <option value="">relay to session…</option>
          {workers.map((s) => <option key={s.session.id} value={s.session.id}>{s.session.role} · {ProviderLabel(s.session.provider)}</option>)}
        </select>
        <button
          className={styles.primaryBtn}
          disabled={!handoffTaskId || !handoffToSessionId}
          onClick={async () => {
            const task = tasks.find((t) => t.id === handoffTaskId)!
            const fromSession = task.assigneeSessionId ?? workers[0]?.session.id
            if (!fromSession) return
            const handoff = await window.hydra.prepareHandoff({ taskId: handoffTaskId, fromSessionId: fromSession })
            await orch.acceptHandoff(handoff.id, handoffToSessionId)
            setHandoffTaskId('')
            setHandoffToSessionId('')
          }}
        >
          Handoff
        </button>
      </div>
      {handoffs.length > 0 && (
        <ul className={styles.list}>
          {handoffs.map((h) => (
            <li key={h.id} className={styles.row}>
              <span className={`${styles.badge} ${styles[`handoff_${h.state}`]}`}>{h.state}</span>
              <span className={styles.rowMain}>task → {h.toSessionId ?? 'unassigned'}</span>
              {h.state === 'accepted' && (
                <button className={styles.miniBtn} onClick={() => void orch.completeHandoff(h.id)}>Complete</button>
              )}
              {h.state === 'completed' && (
                <button className={styles.miniBtn} onClick={() => void orch.syncBackHandoff(h.id, { summary: 'relay work synced back to origin session' })}>
                  Sync back
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
