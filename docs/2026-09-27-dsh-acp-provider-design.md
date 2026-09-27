# DSH (DeepSeek Harness) as a Hydra provider — ACP integration

**Date**: 2026-09-27
**Status**: implemented

## Why ACP, and why a bridge

Hydra's other providers are interactive CLIs: Hydra spawns them in a PTY and renders the
bytes with xterm.js. DSH does not work that way:

- The shipped surfaces are `web` (browser UI), `headless` (one-shot, no follow-up),
  `sdk`, and `acp`. There is **no terminal front-end** — `~/.dsh/profiles/tui` only
  mounts the `dsh-base` bundle.
- `dsh-acp`'s own README calls the ACP server **automation-only**: it exposes committed
  messages/thoughts, generic tool lifecycle, configuration and usage, but no presentation
  cards, plans, todos, terminals, or elicitation, and it never replays history.

So Hydra runs a small bridge **inside the agent tile**: the tile is still a PTY, but the
process in it speaks ACP instead of drawing a TUI.

```
Hydra renderer (xterm) ── keystrokes ──▶ PTY ──▶ dshBridge.js ── JSON-RPC/stdio ──▶ dsh --profile acp
        ▲                                              │                                    │
        └──────────── ANSI render of session/update ────┴──────── session/update ────────────┘
```

The bridge runs under a **real Node** (`node` from PATH, validated with `--version`), not under
Electron's own runtime:

```
command: node                         (from PATH, or Electron + ELECTRON_RUN_AS_NODE as fallback)
args:    [<app>/out/main/dshBridge.js, --resume <id>?, --model <route>?, --yolo?]
```

Two platform facts force this:

- Hydra tiles are **ConPTYs** on Windows and Electron's binary is a GUI-subsystem
  executable: launched with `ELECTRON_RUN_AS_NODE` inside a ConPTY it starts, exits 0,
  and writes **nothing** — a silently blank tile.
- Stock Node cannot read inside `app.asar`, so packaged builds run the copy that
  `electron-builder.yml` unpacks to `app.asar.unpacked/out/main/dshBridge.js`
  (`resolveBridgePath`).

## Files

| Path | Role |
|---|---|
| `electron/agents/dsh/acpClient.ts` | Dependency-free ACP client: ndjson framing, request/response correlation, server notifications and requests, error mapping, timeouts. |
| `electron/agents/dsh/render.ts` | Pure `session/update` → ANSI translation (messages, thoughts, tool lifecycle, usage, config), banner, permission prompt. |
| `electron/agents/dsh/bridge.ts` | The tile process: spawns `dsh --profile acp`, line editor (history, cursor, multi-line paste), slash commands, permission prompts, one-shot (`--prompt`) headless mode. |
| `electron/sessions/DshSessionCatalog.ts` | Lists existing DSH sessions and subagent filtering, from `~/.dsh`. |
| `electron/agents/providers.ts` | `dsh` provider: `resolveSpawn`/`resolveHeadlessSpawn`, bridge argv, `sessionIdRegex`, preflight. |
| `electron.vite.config.ts` | Adds `dshBridge` as a second main-bundle entry (`out/main/dshBridge.js`). |

Renderer/provider plumbing is shared with the other providers: `ProviderId` union,
`PROVIDER_MODELS.dsh`, `PROVIDER_LABELS.dsh`, provider icons, provider pickers, the
`providerSchema` IPC gate, `WorkspaceStore` restore validation, `ProviderModelCatalog`,
`HeadlessOrchestrator`, `McpServer`, `SkillScanner`, and the daemon `/sessions` route.

## Sessions: listing and resuming

DSH stores each session twice under `$DSH_HOME` (default `~/.dsh`):

- `sessions/<encoded-workspace>/<sessionId>/session.v3.jsonl.zstd` — the append-only log.
  Older sessions (the majority on a long-lived install) are named `session.jsonl.zstd`.
  Its mtime is the session's last activity.
- `storages/session_projcache/sessions/<sessionId>.json` — cwd, createdAt, title, first
  prompt, turn count. The aggregate `storages/session_projcache.json` is the fallback.

The catalog lists **root** sessions only: a session whose projcache row `subagent.val`
carries an `identity` is a subagent child, and DSH's `session/resume` rejects those
(`session is not resumable`). Session transcripts are not read: the log is a chain of
independent Zstandard frames, so `get_history` returns an empty transcript for DSH
(resuming restores the agent's context, not the client's view of the past).

Resuming is native: `session/resume` takes `{sessionId, cwd}` and requires the cwd to
match the persisted one physically — which holds because imported agents inherit their
`projectDir` from the session's own cwd.

**DSH allows one writer per session.** A session can only be resumed while no other DSH
process holds a write handle on it; otherwise the server answers
`-32603 Internal error` with `data.details` = `session "<id>" is already owned by an
active write handle`. In practice that means:

- sessions the running **DSH web app** knows about are locked (close the session there, or
  quit that DSH instance, then retry);
- sessions created and released by another profile/process (e.g. `headless`) resume fine;
- sessions Hydra itself created resume fine;
- an **orphaned** `dsh --profile acp` also holds handles, which is why an agent stop must
  take the whole process tree down (see `killTreeOnStop`).

The bridge surfaces `data.details` verbatim plus that hint, so the tile never shows a bare
"Internal error".

## Models

The ACP `model` config option is a select whose **values are opaque**:
`JSON.stringify([provider, model])`. The bridge matches the requested route
(`deepseek-official/deepseek-v4-flash`) against the advertised option groups and sends the
advertised value back, so `/model` and Hydra's model pill always agree with the live
catalog. `PROVIDER_MODELS.dsh` is only a dropdown seed; `/model` with no argument prints
the live list advertised by the server.

## Commands inside a DSH tile

`/help`, `/model [route]`, `/reasoning <effort>`, `/status`, `/cancel`, `/exit`.
Ctrl-C cancels the running turn, Ctrl-D closes the session. Hydra's model pill writes
`/model <id>` into the tile, which is exactly what the bridge expects.

## Known limitations

- **No transcript replay.** Opening an imported DSH session shows the banner, then new
  turns; the earlier conversation is not rendered (the log is multi-frame Zstandard, and
  ACP deliberately does not replay updates).
- **A session held by another DSH process cannot be resumed** (see above). Hydra reports
  why, but it cannot take the handle away.
- **Hydra's MCP tools are not injected.** `session/new` passes `mcpServers: []`, so a DSH
  agent cannot call back into Hydra (create/kill agents) the way the other providers can.
- **Usage dashboard has no DSH data.** `ccusage` covers Claude/Codex only; the DSH provider
  tab intentionally reports "not available" rather than showing Claude numbers.
- **Skills tab does not scan DSH skills.** `~/.dsh/skills` is not read; the tab shows an
  empty list for DSH instead of leaking Codex skills.
- **Static dropdown list.** A model that the local DSH install does not offer is rejected
  by the bridge with a warning (the session keeps the provider default).
- **Headless runs need `--yolo` to auto-approve.** Without it a permission request is
  denied (nobody is watching stdin in a one-shot run).
- **`initialize` can take tens of seconds** when DSH resolves the configured model's
  capabilities against a slow provider catalog; Hydra allows 90s and shows
  `· starting dsh --profile acp…` meanwhile.

## Verifying a change

```bash
npm run build                       # produces out/main/dshBridge.js
node out/main/dshBridge.js --prompt "Reply with exactly: BRIDGE-OK"   # stdout = answer, stderr = log
node out/main/dshBridge.js --resume <sessionId> --prompt "…"          # context must survive
printf 'a prompt\n' | node out/main/dshBridge.js                      # interactive path, EOF drains the queue
```

Two traps when testing by hand, both of which hid real bugs:

- **Pipes are not a PTY.** A bridge that works with piped stdio can still render nothing in
  a tile. Reproduce tile conditions with node-pty:
  `pty.spawn(nodeExe, [bridge], { cols: 120, rows: 30, env: { ...process.env } })`.
- **The prompt is echoed into the tile**, so waiting for the answer text matches the echo
  first. Assert on the answer as its own line (`/^\s*TOKEN\s*$/m`).

The strongest end-to-end check is Hydra's own daemon: start
`node out/main/daemon.js --user-data <tmp> --socket-path <pipe>`, `POST /agents`
(`provider: 'dsh'`, an `initialPrompt`, optionally `resumeSessionId`), then read
`GET /agents/:id/buffer` — that is literally the text the tile renders. Afterwards confirm
no `dsh --profile acp` process was left behind.

`electron/agents/providers.test.ts`, `electron/agents/dsh/acpClient.test.ts`,
`electron/agents/dsh/render.test.ts`, and `electron/sessions/DshSessionCatalog.test.ts`
cover spawn resolution (system Node, unpacked bridge path, kill-tree), framing, rendering
(including the raw-banner → `sessionIdRegex` invariant) and catalog parsing. When touching
session listing, cross-check against the server itself — `session/list` is read-only and
returns exactly the sessions `session/resume` will accept.

Env overrides for non-default installs: `DSH_BIN` (default `dsh`) and `DSH_PROFILE`
(default `acp`).

## Operator note

If `~/.dsh/.env` exists as a **directory**, every DSH boot logs
`dsh: failed to load .env: EISDIR`; the bridge surfaces it dimmed in the tile. It is
harmless, but removing the stray directory silences it.
