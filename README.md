# @sreagent/mcp-router

A generic MCP (Model Context Protocol) server that acts as a **routing proxy** — it sits between an MCP client and one or more downstream MCP server processes, transparently multiplexing tool calls across multiple targets based on configurable routing rules.

## Why

A single MCP server instance is typically bound to one set of credentials and one target resource (e.g., one Kusto cluster). When an agent needs to query **multiple** clusters — each with its own managed identity — you would normally need to configure a separate MCP server per cluster and teach the agent which one to call.

`mcp-router` eliminates that by:

1. Spawning downstream MCP server processes **on demand** with per-target environment variables (e.g., different `AZURE_CLIENT_ID` per cluster).
2. Presenting a **single unified tool list** to the upstream MCP client.
3. **Routing** each `tools/call` request to the correct downstream based on a parameter value (e.g., `cluster-uri`), or **fanning out** to all downstreams when no specific target is specified.

## Architecture

```
┌──────────────┐      stdio       ┌──────────────┐      stdio      ┌──────────────────────┐
│  MCP Client  │ ◄──────────────► │  mcp-router  │ ──────────────► │ Downstream MCP #1    │
│  (LLM Agent) │                  │              │                  │ (e.g. Kusto Cluster1)│
└──────────────┘                  │              │      stdio      ├──────────────────────┤
                                  │              │ ──────────────► │ Downstream MCP #2    │
                                  │              │                  │ (e.g. Kusto Cluster2)│
                                  └──────────────┘                  └──────────────────────┘
```

### Key components

| File | Purpose |
|---|---|
| `index.ts` | CLI entry point — parses `--args`, `--env`, `--router` flags and orchestrates startup |
| `downstream-manager.ts` | Lazily spawns and manages child MCP server processes; handles connection, reconnection, idle cleanup, and shutdown |
| `tool-router.ts` | Matches tool calls to routing entries by glob pattern and routes to the correct downstream(s) |
| `router-parser.ts` | Parses `--router` spec strings and computes stable hash keys for downstream deduplication |
| `server.ts` | Creates the stdio-based MCP server that exposes `tools/list` and `tools/call` to the upstream client |
| `lifecycle.ts` | Handles graceful shutdown on SIGINT, SIGTERM, stdin close, and uncaught errors |
| `logger.ts` | Structured logging to stderr and an optional log file (keeps stdout clean for MCP protocol) |
| `types.ts` | Shared TypeScript interfaces (`RouterEntry`, `RouterConfig`, `ToolDefinition`, etc.) |

## Usage

```bash
mcp-router \
  --args npx --args -y --args @azure/mcp@latest \
  --args server --args start --args --namespace --args kusto \
  --env AZURE_TENANT_ID=abc123 \
  --router 'kusto_*.cluster-uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="id1"' \
  --router 'kusto_*.cluster-uri="https://cluster2.kusto.windows.net"; AZURE_CLIENT_ID="id2"'
```

### CLI flags

| Flag | Description |
|---|---|
| `--args <token>` | A single argument token forwarded verbatim to each child MCP process. Repeatable — one flag per token. The first `--args` token is the command, the rest are its arguments. |
| `--env <KEY=VALUE>` | Environment variable applied to **all** child processes (lowest priority). Repeatable. |
| `--router <spec>` | Routing target specification. Repeatable — one per downstream target. See format below. |
| `--log-level <level>` | Log level: `debug`, `info`, `warn`, `error`. Default: `info`. |

### `--router` spec format

```
toolPattern.injectParam="injectValue"[; ENV_KEY="envValue"]...
```

- **`toolPattern`** — glob pattern matching tool names (e.g., `kusto_*`, `cosmos_*`, `*`). Only `*` wildcards are supported.
- **`injectParam`** — the tool parameter used for routing (e.g., `cluster-uri`).
- **`injectValue`** — the value identifying this particular downstream target.
- **`ENV_KEY="envValue"`** — optional per-downstream environment variable overrides, separated by `;`.

Examples:

```bash
# Route kusto tools by cluster-uri, each with its own managed identity
--router 'kusto_*.cluster-uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="id1"'
--router 'kusto_*.cluster-uri="https://cluster2.kusto.windows.net"; AZURE_CLIENT_ID="id2"'
```

### Pass-through mode

If no `--router` flags are provided, the router runs in **pass-through mode**: all tool calls are forwarded to a single default downstream process spawned from `--args`.

## Routing logic

When a `tools/call` request arrives, the router:

1. **Pattern match** — finds all `--router` entries whose `toolPattern` glob matches the tool name.
2. **No match** → routes to the default downstream (no parameter injection).
3. **`injectParam` value present in args** → routes to the specific downstream whose `injectValue` matches.
4. **Single match, no `injectParam` in args** → auto-injects the configured value and routes to that downstream.
5. **Multiple matches, no `injectParam` in args** → fans out the call to all matching downstreams and merges results.

## Environment variable priority

Environment variables for child processes are resolved with this priority (highest wins):

1. **`--router` `ENV_KEY`** — per-entry overrides (e.g., `AZURE_CLIENT_ID`)
2. **`process.env`** — the mcp-router's own inherited environment
3. **`--env`** — global env flags (lowest priority)

## Downstream lifecycle

- **Lazy creation** — downstream processes are spawned on first tool call, not at startup.
- **Probe** — the first configured entry (or default) is probed eagerly at startup to discover tool schemas for `tools/list`.
- **Deduplication** — downstreams with identical `--args` + resolved env share a single child process (keyed by SHA-256 hash). The `injectParam`/`injectValue` are **not** part of the key — only the command, its arguments, and the final set of environment variables determine whether two entries share a process.
- **Idle cleanup** — downstreams with no tool calls for 20 minutes are automatically terminated. A periodic sweep runs every 60 seconds.
- **Reconnection** — if a downstream process crashes, the next tool call triggers an automatic inline reconnect attempt.
- **Graceful shutdown** — on SIGINT/SIGTERM, children receive SIGTERM then SIGKILL after 1 second. On stdin close (parent disconnect), children are SIGKILLed immediately.

### How many child processes are created?

The number of child MCP processes depends on how many **unique (args + resolved env)** combinations exist across all `--router` entries. Here are some examples:

**Example 1: Two clusters, two identities → 2 child processes**

```bash
mcp-router \
  --args npx --args -y --args @azure/mcp@latest --args server --args start \
  --router 'kusto_*.cluster-uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="id-AAA"' \
  --router 'kusto_*.cluster-uri="https://cluster2.kusto.windows.net"; AZURE_CLIENT_ID="id-BBB"'
```

Each entry has a different `AZURE_CLIENT_ID`, so their resolved env differs → **2 child processes**.

**Example 2: Two clusters, same identity → 1 child process**

```bash
mcp-router \
  --args npx --args -y --args @azure/mcp@latest --args server --args start \
  --router 'kusto_*.cluster-uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="id-AAA"' \
  --router 'kusto_*.cluster-uri="https://cluster2.kusto.windows.net"; AZURE_CLIENT_ID="id-AAA"'
```

Both entries have the same `AZURE_CLIENT_ID` and no other env differences. The downstream key (SHA-256 of args + env) is identical → **1 child process** is shared. Tool calls are differentiated by the `cluster-uri` parameter injected into the request, not by the process.

**Example 3: Three clusters, two identities → 2 child processes**

```bash
mcp-router \
  --args npx --args -y --args @azure/mcp@latest --args server --args start \
  --router 'kusto_*.cluster-uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="id-AAA"' \
  --router 'kusto_*.cluster-uri="https://cluster2.kusto.windows.net"; AZURE_CLIENT_ID="id-AAA"' \
  --router 'kusto_*.cluster-uri="https://cluster3.kusto.windows.net"; AZURE_CLIENT_ID="id-BBB"'
```

Clusters 1 and 2 share `id-AAA` → same child process. Cluster 3 uses `id-BBB` → separate child process. **2 child processes** total.

**Example 4: No env overrides → 1 child process**

```bash
mcp-router \
  --args npx --args -y --args @azure/mcp@latest --args server --args start \
  --router 'kusto_*.cluster-uri="https://cluster1.kusto.windows.net"' \
  --router 'kusto_*.cluster-uri="https://cluster2.kusto.windows.net"'
```

Neither entry specifies env overrides, so resolved env is identical → **1 child process**.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in watch mode
npm run dev

# Run tests
npm test

# Type check
npm run typecheck
```

Requires Node.js >= 20.
