import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { AgentManager } from '../agents/AgentManager'
import type { NotificationService } from '../notifications/NotificationService'
import type { OrchestrationService } from '../orchestration/OrchestrationService'
import type { McpServerStatus } from '@shared/types'
import { setupManagerWorkspace } from './manager-workspace'

interface SessionEntry {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

export class HydraMcpServer {
  private httpServer: Server | null = null
  private port: number | null = null
  private managerWorkspace: string | null = null
  private sessions = new Map<string, SessionEntry>()
  private error: string | null = null
  private notificationService: NotificationService | null = null

  constructor(
    private readonly agentManager: AgentManager,
    private readonly userDataPath: string,
    private readonly orchestration: OrchestrationService | null = null
  ) {}

  setNotificationService(service: NotificationService): void {
    this.notificationService = service
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        console.error('[MCP] Request handler error:', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      })
    })

    this.port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          resolve(addr.port)
        } else {
          reject(new Error('Failed to get server address'))
        }
      })
      server.on('error', reject)
    })

    this.httpServer = server
    this.managerWorkspace = setupManagerWorkspace(this.userDataPath, this.port)
    this.error = null
  }

  stop(): void {
    for (const [, entry] of this.sessions) {
      entry.transport.close().catch(() => {})
    }
    this.sessions.clear()

    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }
  }

  getStatus(): McpServerStatus {
    return {
      running: this.httpServer !== null,
      port: this.port,
      error: this.error,
      managerWorkspace: this.managerWorkspace
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)

    // ── Notification endpoints ──────────────────────────────────────────────

    if (url.pathname === '/notifications/stream' && req.method === 'GET') {
      this.handleNotificationStream(res)
      return
    }

    if (url.pathname === '/notifications' && req.method === 'GET') {
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200) : 50
      const recent = this.notificationService?.getRecent(limit) ?? []
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(recent))
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // Handle DELETE for session cleanup
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && this.sessions.has(sessionId)) {
        const entry = this.sessions.get(sessionId)!
        await entry.transport.handleRequest(req, res)
        this.sessions.delete(sessionId)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Session not found' }))
      }
      return
    }

    // Handle GET for SSE stream (if client wants one)
    if (req.method === 'GET') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && this.sessions.has(sessionId)) {
        const entry = this.sessions.get(sessionId)!
        await entry.transport.handleRequest(req, res)
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Session ID required' }))
      }
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    // Parse JSON body
    const body = await this.readBody(req)

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (sessionId && this.sessions.has(sessionId)) {
      // Existing session
      const entry = this.sessions.get(sessionId)!
      await entry.transport.handleRequest(req, res, body)
    } else {
      // New session
      const entry = await this.createSession()
      await entry.transport.handleRequest(req, res, body)
    }
  }

  private async createSession(): Promise<SessionEntry> {
    const server = new McpServer(
      { name: 'hydra', version: '0.1.0' },
      { capabilities: { logging: {} } }
    )

    this.registerTools(server)

    const entry: SessionEntry = { server, transport: null as unknown as StreamableHTTPServerTransport }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid: string) => {
        this.sessions.set(sid, entry)
      }
    })

    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId)
      }
    }

    entry.transport = transport
    await server.connect(transport)

    return entry
  }

  private registerTools(server: McpServer): void {
    this.registerOrchestrationTools(server)

    server.tool(
      'hydra_list_agents',
      'List all Hydra agents with their current status, model, project directory, and session info',
      {},
      async () => {
        const agents = this.agentManager.list()
        const summary = agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          model: a.model,
          projectDir: a.projectDir,
          isManager: a.isManager,
          yolo: a.yolo,
          sessionId: a.sessionId
        }))
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }]
        }
      }
    )

    server.tool(
      'hydra_create_agent',
      'Create a new Hydra agent in a project directory. The agent will start a Claude CLI session.',
      {
        name: z.string().min(1).max(120).describe('Agent name'),
        projectDir: z.string().min(1).max(4096).describe('Absolute path to the project directory'),
        provider: z.enum(['claude', 'codex', 'opencode', 'dsh']).default('claude').describe('CLI provider to use (claude, codex, opencode, or dsh)'),
        model: z.string().min(1).max(128).describe('Model to use (e.g. opus, sonnet, haiku, gpt-5.3-codex)'),
        reasoningEffort: z.string().max(32).optional().describe('Reasoning effort level for Codex (low, medium, high, extra_high)'),
        initialPrompt: z.string().max(20000).default('').describe('Initial prompt to send after startup'),
        yolo: z.boolean().default(false).describe('Skip all permission prompts')
      },
      async ({ name, projectDir, provider, model, reasoningEffort, initialPrompt, yolo }) => {
        try {
          const state = await this.agentManager.create({
            name,
            projectDir,
            provider,
            model,
            reasoningEffort,
            yolo,
            initialPrompt,
            isManager: false // Prevent recursive managers
          })
          return {
            content: [
              {
                type: 'text' as const,
                text: `Agent created successfully:\n${JSON.stringify(
                  { id: state.id, name: state.name, status: state.status, projectDir: state.projectDir },
                  null,
                  2
                )}`
              }
            ]
          }
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to create agent: ${err instanceof Error ? err.message : String(err)}`
              }
            ],
            isError: true
          }
        }
      }
    )

    server.tool(
      'hydra_send_prompt',
      'Send a prompt/message to a specific agent. The agent must be running.',
      {
        agentId: z.string().min(1).max(128).describe('Agent ID'),
        prompt: z.string().min(1).max(20000).describe('Prompt text to send')
      },
      async ({ agentId, prompt }) => {
        const success = this.agentManager.sendInput(agentId, prompt)
        if (success) {
          return {
            content: [{ type: 'text' as const, text: `Prompt sent to agent ${agentId}` }]
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to send prompt to agent ${agentId}. Agent may not exist or not be running.`
            }
          ],
          isError: true
        }
      }
    )

    server.tool(
      'hydra_get_output',
      'Get recent terminal output from an agent. Returns the last N lines of the output buffer.',
      {
        agentId: z.string().min(1).max(128).describe('Agent ID'),
        lines: z.number().int().min(1).max(5000).default(100).describe('Number of lines to retrieve')
      },
      async ({ agentId, lines }) => {
        const buffer = this.agentManager.getBuffer(agentId)
        if (buffer.length === 0) {
          const agent = this.agentManager.get(agentId)
          if (!agent) {
            return {
              content: [{ type: 'text' as const, text: `Agent ${agentId} not found` }],
              isError: true
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Agent ${agentId} (${agent.name}) has no output yet. Status: ${agent.status}`
              }
            ]
          }
        }

        const tail = buffer.slice(-lines)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Output from agent ${agentId} (last ${tail.length} of ${buffer.length} lines):\n\n${tail.join('\n')}`
            }
          ]
        }
      }
    )

    server.tool(
      'hydra_broadcast',
      'Send the same prompt to all agents working in a specific project directory',
      {
        projectDir: z.string().min(1).max(4096).describe('Project directory path'),
        prompt: z.string().min(1).max(20000).describe('Prompt to broadcast')
      },
      async ({ projectDir, prompt }) => {
        const sentTo = this.agentManager.broadcast(projectDir, prompt)
        if (sentTo.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No agents found for project directory: ${projectDir}`
              }
            ],
            isError: true
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Broadcast sent to ${sentTo.length} agent(s): ${sentTo.join(', ')}`
            }
          ]
        }
      }
    )

    server.tool(
      'hydra_kill_agent',
      'Kill a running agent. Sends SIGTERM followed by SIGKILL after timeout.',
      {
        agentId: z.string().min(1).max(128).describe('Agent ID to kill')
      },
      async ({ agentId }) => {
        const killed = this.agentManager.kill(agentId)
        if (killed) {
          return {
            content: [{ type: 'text' as const, text: `Kill signal sent to agent ${agentId}` }]
          }
        }
        return {
          content: [{ type: 'text' as const, text: `Agent ${agentId} not found` }],
          isError: true
        }
      }
    )

    server.tool(
      'hydra_restart_agent',
      'Restart an agent. Kills the current process and spawns a new one, preserving the session.',
      {
        agentId: z.string().min(1).max(128).describe('Agent ID to restart')
      },
      async ({ agentId }) => {
        const state = this.agentManager.restart(agentId)
        if (state) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Agent ${agentId} restarted. Status: ${state.status}, Restart count: ${state.restartCount}`
              }
            ]
          }
        }
        return {
          content: [{ type: 'text' as const, text: `Agent ${agentId} not found` }],
          isError: true
        }
      }
    )

    server.tool(
      'hydra_get_notifications',
      'Get recent Hydra notifications (agent status changes, headless run completions/errors). Use this to check what happened while you were busy.',
      {
        limit: z.number().int().min(1).max(200).default(20).describe('Maximum number of notifications to return')
      },
      async ({ limit }) => {
        const notifications = this.notificationService?.getRecent(limit) ?? []
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(notifications, null, 2) }]
        }
      }
    )
  }

  private registerOrchestrationTools(server: McpServer): void {
    const orch = this.orchestration
    if (!orch) return

    const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
    const err = (message: string) => ({
      content: [{ type: 'text' as const, text: message }],
      isError: true
    })

    server.tool(
      'hydra_group_create',
      'Create an Agent Group: a long-lived container for a Manager and its member Harness sessions.',
      {
        name: z.string().min(1).max(120),
        projectRefs: z.array(z.string().max(4096)).optional()
      },
      async ({ name, projectRefs }) => {
        try {
          return ok(JSON.stringify(orch.createGroup({ name, projectRefs }), null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_group_get_state',
      'Get the state of all groups (or one group): members, tasks, quota, checkpoints and handoffs.',
      {
        groupId: z.string().max(128).optional()
      },
      async ({ groupId }) => {
        const snapshot = orch.snapshot()
        const groups = groupId ? snapshot.groups.filter((g) => g.group.id === groupId) : snapshot.groups
        return ok(JSON.stringify(groups, null, 2))
      }
    )

    server.tool(
      'hydra_group_add_session',
      'Register a Harness session and add it to a group. Records the provider, native session id, cwd and role.',
      {
        groupId: z.string().max(128),
        provider: z.enum(['claude', 'codex', 'opencode', 'dsh']),
        cwd: z.string().min(1).max(4096),
        projectRef: z.string().min(1).max(4096),
        role: z.enum(['manager', 'planner', 'worker']),
        nativeSessionId: z.string().max(256).optional(),
        quotaPoolId: z.string().max(128).optional()
      },
      async ({ groupId, provider, cwd, projectRef, role, nativeSessionId, quotaPoolId }) => {
        try {
          const session = orch.addSession({
            groupId,
            provider,
            cwd,
            projectRef,
            role,
            nativeSessionId: nativeSessionId ?? null,
            quotaPoolId: quotaPoolId ?? null
          })
          return ok(JSON.stringify(session, null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_session_suspend',
      'Suspend a Harness session (stops new dispatch; the session is not deleted).',
      { sessionId: z.string().max(128) },
      async ({ sessionId }) => {
        try {
          return ok(JSON.stringify(orch.suspendSession(sessionId), null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_session_resume',
      'Mark a suspended session resume-pending; provider validation confirms it before work resumes.',
      { sessionId: z.string().max(128) },
      async ({ sessionId }) => {
        try {
          return ok(JSON.stringify(orch.resumeSession(sessionId), null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_task_assign',
      'Create a task in a group and optionally assign it to an existing session (never auto-creates one).',
      {
        groupId: z.string().max(128),
        goal: z.string().min(1).max(4000),
        acceptanceCriteria: z.array(z.string().max(1000)).optional(),
        sessionId: z.string().max(128).optional()
      },
      async ({ groupId, goal, acceptanceCriteria, sessionId }) => {
        try {
          const task = orch.createTask({ groupId, goal, acceptanceCriteria })
          if (sessionId) {
            const assigned = orch.assignTask({ taskId: task.id, sessionId })
            return ok(JSON.stringify(assigned, null, 2))
          }
          return ok(JSON.stringify(task, null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_task_report',
      'Report verifiable progress on a task with optional completed items and artifacts.',
      {
        taskId: z.string().max(128),
        note: z.string().max(4000),
        completed: z.array(z.string().max(1000)).optional(),
        artifacts: z.array(z.string().max(4096)).optional()
      },
      async ({ taskId, note, completed, artifacts }) => {
        try {
          const task = orch.reportProgress({ taskId, note, completed, artifacts })
          return ok(JSON.stringify(task, null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_quota_get_status',
      'Get the quota pool status for a session (availability, source, confidence, reset time).',
      { sessionId: z.string().max(128) },
      async ({ sessionId }) => {
        const session = orch.sessions.get(sessionId)
        if (!session) return err(`Session not found: ${sessionId}`)
        const pool = session.quotaPoolId ? orch.quota.get(session.quotaPoolId) : null
        return ok(JSON.stringify({ sessionId, quotaPoolId: session.quotaPoolId, pool }, null, 2))
      }
    )

    server.tool(
      'hydra_quota_mark_blocked',
      'Manually mark a quota pool blocked (or available) with a real source; never fabricates a reset time.',
      {
        poolId: z.string().max(128),
        availability: z.enum(['available', 'degraded', 'blocked', 'unknown']),
        resetAt: z.string().max(64).optional(),
        source: z.enum(['official', 'cli_signal', 'manual', 'estimated', 'unknown']).optional()
      },
      async ({ poolId, availability, resetAt, source }) => {
        try {
          const pool = orch.markQuota({ poolId, availability, resetAt: resetAt ?? null, source })
          return ok(JSON.stringify(pool, null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_checkpoint_capture',
      'Capture a task checkpoint for a session: completed work, next steps, decisions and safe Git metadata.',
      {
        sessionId: z.string().max(128),
        taskId: z.string().max(128).optional(),
        completed: z.array(z.string().max(1000)).optional(),
        nextSteps: z.array(z.string().max(1000)).optional(),
        decisions: z.array(z.string().max(1000)).optional(),
        branch: z.string().max(256).optional(),
        gitBaseCommit: z.string().max(128).optional(),
        dirtyPaths: z.array(z.string().max(4096)).optional()
      },
      async ({ sessionId, taskId, completed, nextSteps, decisions, branch, gitBaseCommit, dirtyPaths }) => {
        try {
          const checkpoint = orch.captureCheckpoint({
            sessionId,
            taskId: taskId ?? null,
            completed,
            nextSteps,
            decisions,
            branch: branch ?? null,
            gitBaseCommit: gitBaseCommit ?? null,
            dirtyPaths
          })
          return ok(JSON.stringify(checkpoint, null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_handoff_prepare',
      'Prepare a handoff: move a task from one session with materials, checkpoint and acceptance criteria.',
      {
        taskId: z.string().max(128),
        fromSessionId: z.string().max(128),
        materials: z.array(z.string().max(4096)).optional()
      },
      async ({ taskId, fromSessionId, materials }) => {
        try {
          return ok(JSON.stringify(orch.prepareHandoff({ taskId, fromSessionId, materials }), null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )

    server.tool(
      'hydra_handoff_accept',
      'Accept a handoff into another Harness session, transferring the task without deleting the original.',
      {
        handoffId: z.string().max(128),
        toSessionId: z.string().max(128)
      },
      async ({ handoffId, toSessionId }) => {
        try {
          return ok(JSON.stringify(orch.acceptHandoff({ handoffId, toSessionId }), null, 2))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    )
  }

  private handleNotificationStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(':\n\n') // SSE comment to establish connection

    const unsubscribe = this.notificationService?.subscribe((notification) => {
      res.write(`data: ${JSON.stringify(notification)}\n\n`)
    })

    res.on('close', () => {
      unsubscribe?.()
    })
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8')
          resolve(raw ? JSON.parse(raw) : undefined)
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }
}
