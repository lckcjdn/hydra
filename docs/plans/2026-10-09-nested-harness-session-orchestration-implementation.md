# Hydra 分层 Agent Group 与跨 Harness Session 接力 — 开发结果文档

> 状态：**V1 (P0) 已实现** · 日期：2026-10-09 · 对应计划：[2026-10-09-nested-harness-session-orchestration.md](./2026-10-09-nested-harness-session-orchestration.md)
>
> 本文档记录对远端 PR #1 的接受/合并，以及按该改造计划落地 V1 功能后的开发结果。

## 0. 结论摘要

1. **PR 已合并**：远端 agent 提交的设计草案 PR（`lckcjdn/hydra#1`，仅含设计文档 + 3 张 SVG）已标记 ready 并合并（merge commit `5b9864b`），分支 `docs/nested-harness-session-orchestration-20261009` 已删除。
2. **V1 已按计划实现**：新增了计划 §2/§3/§4/§6/§7 中 V1 (P0) 范围的分层 Group 数据模型、持久化、编排核心、配额管理、调度 MCP 工具、daemon/IPC/preload 通信层，以及 Group/配额/接力 UI。
3. **明确未实现**（诚实边界）：V2 自动额度事件、V3 智能路由/多级 Group/自动 Planner，以及“跨 Provider 原生会话迁移”均未实现——这与计划 §1.2 的“不在 V1”一致。
4. **验证**：`npm run typecheck`（node + web）通过；`npm test` 全部 193 个用例通过（含新增 13 个编排核心用例）。

---

## 1. 交付范围与计划映射

| 计划条目 | 交付情况 | 说明 |
| --- | --- | --- |
| §2 五种对象区分 + 数据模型 | ✅ | `AgentGroup` / `HarnessSession` / `QuotaPool` / `TaskAssignment` / `SessionCheckpoint` + `HandoffRecord` 全部落地到 `shared/types.ts` |
| §2.1 持久化数据草案 | ✅ | 类型与原草案一致，另补 `HandoffRecord`（原草案隐含在状态机中） |
| §3.1 Hydra Core 确定性服务 | ✅ | `GroupManager` / `SessionCoordinator` / `TaskDispatcher` / `CheckpointManager` / `HandoffManager` / `EventJournal` 全部实现，均不依赖 LLM |
| §3.2 Manager/Planner/Worker 角色 | ✅ | `SessionRole = manager | planner | worker`；Planner 不拥有 Worker 任务派发（`TaskDispatcher.assign` 拒绝 planner） |
| §3.3 Session 运行适配 + 隔离 | ✅(部分) | `findConflictingWriters()` 检测同 cwd 双写者；Worktree 隔离沿用现有 `AgentManager`；Provider 能力声明未做（V1 人工交接即可） |
| §4.1 Quota Adapter 接口 | ✅ | `QuotaAdapter` + `classifyQuotaSignal` + Codex/DSH/GLM 适配器（V1 诚实返回 unknown/null，不伪造恢复时间） |
| §4.2 接力状态机 | ✅ | Active → Quota blocked → Checkpoint → Handoff → Continue → Quota recovered → Sync back → No forced preemption，映射为任务/交接状态迁移 |
| §5 结构化进展事件流 | ✅ | `EventJournal` 记录全部 20 类事件，含 `eventId`/`groupId`/`sessionId`/`taskId`/`occurredAt`/`source`/`evidence`/单调 `sequence` |
| §6 具体改动位置 | ✅ | 见下方“新增文件清单”；实现时以现有 `daemon` / `stores` 工程结构为准（如计划所允许） |
| §7 拟新增调度 MCP 工具 | ✅ | 见下方“MCP 工具”小节，共 11 个工具 |
| §8 P0/V1 验收标准 | ✅ | 见下方“验收标准覆盖” |
| §8 最低自动测试集合 | ✅(9/10) | 第 10 条（Windows DSH 孤儿进程）由现有 `providers.test.ts` 的 `killTreeOnStop` 覆盖，其余 9 条由 `OrchestrationService.test.ts` 覆盖 |

---

## 2. 新增/修改文件清单

### 2.1 合并的 PR（设计文档，未改运行时代码）

```
docs/plans/2026-10-09-nested-harness-session-orchestration.md   # 改造计划
docs/figures/nested-harness-architecture.svg                     # 架构图
docs/figures/quota-handoff-flow.svg                              # 接力流程图
docs/figures/agent-group-wireframe.svg                           # UI 示意图
```

### 2.2 新增源码

```
shared/types.ts（修改：新增编排/配额类型 + IPC 通道）
electron/orchestration/OrchestrationStore.ts       # JSON 状态 + JSONL 事件日志持久化
electron/orchestration/EventJournal.ts             # 单调递增事件日志（幂等键 + 顺序号）
electron/orchestration/GroupManager.ts             # Group CRUD、成员、Manager、环检测
electron/orchestration/SessionCoordinator.ts       # Session 注册/生命周期/写冲突/agent 对账
electron/orchestration/TaskDispatcher.ts           # Task 队列、派发、进度、配额冻结
electron/orchestration/CheckpointManager.ts        # 阶段检查点 + 安全 Git 元数据
electron/orchestration/HandoffManager.ts           # 接力 prepare/accept/complete/sync-back
electron/orchestration/OrchestrationService.ts     # 门面（daemon/MCP 唯一入口）
electron/orchestration/index.ts                    # 桶导出
electron/orchestration/OrchestrationService.test.ts# 13 个核心单测
electron/quota/adapters.ts                         # QuotaAdapter 接口 + 信号分类器 + 适配器
electron/quota/QuotaManager.ts                     # 配额池、标记、观察、冻结判定
src/hooks/useOrchestration.ts                      # 渲染层 hook（订阅快照 + 动作）
src/components/AgentGroups/AgentGroupsPanel.tsx    # Group/配额/接力 UI 面板
src/components/AgentGroups/AgentGroupsPanel.module.css
```

### 2.3 修改的集成文件

```
electron/daemon/index.ts          # 实例化 OrchestrationService 并注入 daemon/MCP
electron/daemon/DaemonServer.ts   # /orchestration/* 路由 + orchestration:changed 广播
electron/daemon/DaemonClient.ts   # daemon HTTP 客户端编排方法
electron/daemon/protocol.ts       # WS 消息联合类型 + OrchestrationSnapshot
electron/ipc/handlers.ts          # ORCH_* IPC 处理器（zod 校验）
electron/preload.ts               # window.hydra 编排 API
electron/main.ts                  # 转发 orchestration:changed 到渲染层
electron/mcp/McpServer.ts         # 11 个调度 MCP 工具
shared/keybindings.ts             # 新增 agent-groups 命令 + mod+shift+g 快捷键
src/App.tsx                       # showAgentGroups 状态 + 命令 + 面板渲染
src/components/Sidebar/Sidebar.tsx# Groups 按钮（footer）
src/components/Sidebar/Sidebar.module.css
AGENTLOG.md                       # 记录 1 条开发踩坑
```

---

## 3. 数据模型（`shared/types.ts`）

与原计划 §2.1 草案保持一致，补充了 `HandoffRecord`。关键类型：

```ts
type SessionRole = 'manager' | 'planner' | 'worker'
type SessionLifecycle = 'registered' | 'starting' | 'ready' | 'busy'
  | 'suspended' | 'resume_pending' | 'errored' | 'unavailable'
type QuotaAvailability = 'available' | 'degraded' | 'blocked' | 'unknown'
type QuotaSource = 'official' | 'cli_signal' | 'manual' | 'estimated' | 'unknown'
type TaskState = 'queued' | 'assigned' | 'active' | 'blocked' | 'handoff' | 'review' | 'done'
type HandoffState = 'prepared' | 'accepted' | 'in_progress' | 'completed' | 'synced_back' | 'canceled'
```

设计要点（遵循计划 §2 的五种对象边界）：

- `HarnessSession` 只保存 Provider 原生 Session ID + `cwd` + `projectRef`，**不复制** Provider 内部状态；`agentId` 用于关联正在 Hydra 中运行的 `AgentState`。
- `QuotaPool` 按账号/订阅作用域保存，**不按 Session**；`resetAt` 可为空，UI 不得展示虚构倒计时。
- `AgentGroup.parentGroupId` 保留为可空字段但禁止成环（`GroupManager.wouldCreateCycle`）。
- 现有 `AgentStatus`（进程状态）保持不变，新增独立的 Session/Task/Quota 状态，避免“进程 × Session × Task × Quota”无限组合（计划 §2.1 的明确要求）。

---

## 4. 持久化（`OrchestrationStore` + `EventJournal`）

- **状态**：`<userData>/orchestration.json`，schema version 1，包含 groups/sessions/quotaPools/tasks/checkpoints/handoffs。
- **事件日志**：`<userData>/orchestration-events.jsonl`，append-only，重启后 `EventJournal.hydrate()` 恢复并保持 `sequence` 单调递增，避免重启后重复接力。
- 两者都由 `OrchestrationService(dataDir)` 统一持有；`dataDir = null` 时纯内存（单测用）。

---

## 5. 编排核心（`electron/orchestration/`）

各模块职责与计划 §3.1 一一对应：

- **`GroupManager`**：创建/删除 Group、添加成员 Session、指派 Manager、`parentGroupId` 环检测。
- **`SessionCoordinator`**：
  - `register()` 持久化原生 Session ID + cwd + projectRef + 角色；
  - `suspend()/resume()` 生命周期迁移（resume 先进入 `resume_pending`，由 Provider 校验后才算真恢复，不伪造恢复）；
  - `findConflictingWriters(cwd, exclude)` 检测同目录双写者（隔离原则）；
  - `reconcileAgents(agents)` 用实时 `AgentState` 把 `busy/ready/errored` 回写到关联 Session。
- **`TaskDispatcher`**：`create/assign/reportProgress/setState`；派发到已有 Session 绝不自动新建；`quota.isBlocked(poolId)` 时冻结派发；拒绝 planner 持有 worker 任务。
- **`CheckpointManager`**：`capture()` 落盘 completed/nextSteps/decisions + gitBaseCommit/branch/dirtyPaths/artifacts；`latestForSession()` 供接力读取。
- **`HandoffManager`**：`prepare → accept → complete → sync_back`；只转交明确产物，不接受“同一 Session 转回自身”；`accept` 会把任务 assignee 切到接力 Session，**原 Session 不删除**。
- **`EventJournal`**：20 类事件，每个事件带 `eventId`/`sequence`，作为 Manager 查询与 UI 刷新的单一事实来源。

### 5.1 配额（`electron/quota/`）

- **`QuotaAdapter`** 接口：`observe(raw) → QuotaObservation | null`。
- **`classifyQuotaSignal`** 是关键安全逻辑：裸 `429`、`ECONNREFUSED` 等网络错误**返回 null**（不是额度事件）；只有“quota/rate-limit/billing/credits + exhausted/exceeded”等明确信号才判 `blocked`；**从不返回虚构的 `resetAt`**（计划 §4.1 的硬要求）。
- **`QuotaManager`**：`ensurePool/mark/observe/isBlocked`；`mark` 在 blocked 状态翻转时写 `quota.blocked`/`quota.recovered` 事件。

---

## 6. MCP 工具（`McpServer.ts`）

新增 11 个调度工具，映射计划 §7：

| 工具 | 行为 |
| --- | --- |
| `hydra_group_create` | 创建 Group |
| `hydra_group_get_state` | 返回成员/任务/额度/检查点/接力摘要 |
| `hydra_group_add_session` | 注册并把新/现有 Session 关联进 Group |
| `hydra_session_suspend` / `hydra_session_resume` | 遵循生命周期约束 |
| `hydra_task_assign` | 创建任务并可指定已有 Session（不无条件新建） |
| `hydra_task_report` | 结构化可验收进展回执 |
| `hydra_quota_get_status` | 查看有来源的额度池状态 |
| `hydra_quota_mark_blocked` | 人工/可信信号输入（blocked/available/degraded/unknown） |
| `hydra_checkpoint_capture` | 保存任务状态 + 安全 Git 元数据 |
| `hydra_handoff_prepare` / `hydra_handoff_accept` | 生成/接收接力材料 |

权限边界：这些工具只调度其 Group 内成员；敏感操作（跨组写入/合并）默认不自动执行——V1 不做无人值守自动合并（计划 §7 末段要求）。

---

## 7. 通信层与 API

- **daemon REST**：`/orchestration`（快照）、`/orchestration/events`、`/orchestration/groups`、`/orchestration/sessions`、`/orchestration/tasks`、`/orchestration/checkpoints`、`/orchestration/quota/mark|observe`、`/orchestration/handoffs/prepare|…/accept|…/complete|…/sync-back`。
- **WS 广播**：每次变更后广播 `orchestration:changed`，携带完整 `OrchestrationSnapshot`，渲染层零轮询。
- **IPC**：`IPC.ORCH_*` 通道 + zod 校验（`handlers.ts`）。
- **preload**：`window.hydra.getOrchestrationState / createGroup / addSessionToGroup / … / onOrchestrationChange`。

---

## 8. UI（`src/components/AgentGroups/`）

- 新增 **Agent Groups** 面板：`AgentGroupsPanel.tsx` + `useOrchestration` hook。
- 入口：Sidebar footer 的 **Groups** 按钮，以及快捷键 `mod+shift+g`（命令 `agent-groups`，已注册进 Command Palette）。
- 面板能力：创建 Group、添加 Manager/Planner/Worker Session、Suspend/Resume、标记额度 blocked/available、创建/派发/汇报 Task、捕获 Checkpoint、发起接力（prepare→accept→complete→sync back），并以徽标展示 role/lifecycle/quota/task/handoff 状态。

---

## 9. 验收标准覆盖（计划 §8）

| 编号 | 计划验收点 | 结果 |
| --- | --- | --- |
| 1 | Group 持久化，重启不丢 Session ID/cwd/归属 | ✅ `OrchestrationService.test.ts` 跨实例 rehydrate 用例 |
| 2 | Manager 复用 Codex、创建 DSH，返回分派记录 | ✅ Group/成员/任务 API |
| 3 | 手动暂停后该额度池不可派新任务；可查/备检查点 | ✅ `TaskDispatcher` 配额冻结 + `CheckpointManager` |
| 4 | 转交另一 Harness；恢复原 Session 后发送带证据摘要 | ✅ `HandoffManager` sync-back |
| 5 | 两个写入 Worker 不静默覆盖同目录；冲突可见 | ✅ `SessionCoordinator.findConflictingWriters` |
| 6 | Quota unknown/普通 429 不误判为 5h 耗尽 | ✅ `classifyQuotaSignal` 单测 |
| 7 | 恢复后只在 Provider 校验通过时 Resume | ✅ resume → `resume_pending`（V1 语义化表达） |
| 8 | 重复 handoff/resume 不双进程/重复写 | ✅ 事件日志单调 `sequence` + 状态机幂等 |
| 9 | Manager 停止后事件仍持久化，重启可重建 | ✅ `EventJournal` rehydrate 用例 |
| 10 | Windows DSH 退出无 ACP 孤儿进程 | ✅ 已有 `providers.test.ts`（`killTreeOnStop`） |

---

## 10. 验证结果

```
npm run typecheck:node   ✅ 通过
npm run typecheck:web    ✅ 通过
npm test                 ✅ 30 files / 193 tests 全部通过（含 13 个新增编排用例）
```

未修改现有 Agent 执行行为；老用户工作区 `workspace.json`、`config.json` 完全兼容（编排数据落在独立的 `orchestration.json` / `orchestration-events.jsonl`）。

---

## 11. 后续（V2 / V3，未在本 PR 实现）

按计划 §8 的交付拆分，V1 对应 PR-A + PR-B（+ PR-C 的手动配额部分）。剩余工作：

- **PR-C（V2）**：`QuotaAdapter` 接入官方/稳定接口；自动冻结派工、自动 Checkpoint、自动通知 Manager、恢复探测与退避。
- **PR-D（V3）**：可选 Planner、按能力/额度/依赖的智能路由、多层 Group 权限与竞争写入检测。
- **Provider 能力声明**（`SessionAdapterCapabilities`）：用于把 `kill` 与安全的 `pause` 区分开，并驱动各 Provider 的可暂停/可恢复语义。
