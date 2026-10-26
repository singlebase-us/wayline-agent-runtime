# Wayline Agent Runtime

[中文](./README.zh-CN.md) · [Architecture](./ARCHITECTURE.md) · [Examples](./examples) · [Contributing contract](./AGENT.md)

An embeddable TypeScript runtime for agents that use tools and keep durable conversation state.
Wayline runs the model/tool loop, checkpoints progress, and exposes a common lifecycle through ACP,
HTTP, or your own application. Your application supplies the model, capabilities, and deployment policy.

## What it provides

- **Session lifecycle:** create sessions, send prompts, stream progress, steer active runs, cancel work,
  and close cleanly through `AgentRuntime`.
- **Durable execution:** persist messages, run state, and tool-call outcomes with in-memory, file,
  SQLite, or PostgreSQL stores. The Supabase profile uses the PostgreSQL engine.
- **Controlled concurrency:** FIFO turns within each session, concurrent independent sessions, and
  bounded parallel tools with exclusive barriers for ordered operations.
- **Integrations:** an official-SDK ACP v1 adapter, an HTTP development adapter and CLI, OpenRouter
  and AI SDK provider adapters, local tools, MCP tools, and file-backed skills.
- **Conservative recovery:** checkpoint at model/tool boundaries and reconcile interrupted work
  without automatically replaying tools whose external outcome is unknown.

One process owns one independent agent runtime. Applications can coordinate multiple processes, but
agent discovery, task delegation, scheduling, authentication, tenancy, and UI belong to the host.

```text
Your application / orchestrator
           │
           ├── ACP client ──► Wayline process A ──► Store A
           └── ACP client ──► Wayline process B ──► Store B

Inside each process:
ACP / HTTP / custom adapter
           │
      AgentRuntime
           │
       AgentLoop ──► Model provider
           ├───────► ToolRegistry / MCP / Skills
           └───────► SessionStore
```

## Quick start

Requires **Node.js 22.13.0 or newer** and npm.

```bash
git clone https://github.com/singlebase-us/wayline-agent-runtime.git
cd wayline-agent-runtime
npm ci
npm run example
```

The example uses an in-memory store and a local echo model. It needs no API key and prints `收到：你好`.

### Embed the runtime

After `npm run build`, save this as `demo.mjs` in the repository root and run `node demo.mjs`.
The package name below resolves through the repository's own package exports.

```js
import { createRuntime } from "wayline-agent-runtime";

const runtime = createRuntime({
  model: {
    async complete({ messages }) {
      return { content: `Echo: ${messages.at(-1)?.content ?? ""}` };
    },
  },
  workspaceRoot: process.cwd(),
  requestApproval: async () => false,
});

try {
  await runtime.createSession({ sessionId: "demo" });
  const result = await runtime.prompt({
    sessionId: "demo",
    content: [{ type: "text", text: "Hello, Wayline." }],
  });
  console.log(result.content.map((part) => part.text).join(""));
} finally {
  await runtime.close();
}
```

For another local project, run `npm pack` in this checkout, then install the generated tarball in that
project. These instructions use the repository build and do not depend on a published npm release.

### Built-in and custom tools

`createRuntime()` is the recommended entry point. It registers `bash` and `compress_conversation`
and defaults to an in-memory store. Enabling Bash requires `workspaceRoot`; every command requires
host approval through `requestApproval`, which defaults to denial. A working directory is not a shell
sandbox. Compression uses the main model unless you supply a separate `summarizer`.

```ts
import { createRuntime, type Tool } from "wayline-agent-runtime";

const lookup: Tool = {
  name: "lookup",
  description: "Look up a value",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_arguments, { signal }) {
    signal?.throwIfAborted();
    return { value: 42 };
  },
};

const runtime = createRuntime({
  model, summarizer, workspaceRoot, sessionStore, requestApproval,
  tools: [lookup],
  config: { maxToolRounds: 16, maxToolCalls: 64, timeoutMs: 300_000 },
});
```

The host supplies the model, directory, store, and approval handler in this example.
Disable built-ins with `builtins: { bash: false, compression: false }`.
Duplicate names in `tools` fail. Use `replaceTools: [replacement]` to explicitly replace an existing
registration during construction. After construction, use `runtime.registerTool(tool)`,
`runtime.registerTool(tool, { replace: true })`, or `runtime.unregisterTool(name)`.
Changes affect subsequent Turns only; active Turns retain their snapshots. Session and request tool
selections stay within host-granted capabilities. These are SDK APIs, not an HTTP tool registration endpoint.

Tools default to parallel execution. Declare `executionPolicy: "exclusive"` for external effects that
must remain ordered. Reserve `sessionAccess: "write"` for trusted Session writers. Forward and observe
`context.signal` in tool implementations.

### Execution budgets and shutdown

`createRuntime()` defaults to **16 model rounds, 64 tool calls, and 5 minutes per request**.
Adjust these through `config`. Manual `AgentLoop` construction retains its original defaults: 16 rounds,
with no default tool-count or total timeout limit. One round may contain several tools; the final text
response also consumes a round. Model retries do not consume additional rounds.
Tool calls accumulate across rounds, including failed calls and automatic compression attempts, and reset
for each request. A batch exceeding the remaining allowance is rejected before any of its tools execute
or unpaired assistant tool-call messages are persisted.

Requests can impose tighter budgets, but cannot raise configured Loop limits:

```ts
await runtime.prompt({
  sessionId: "demo",
  content: [{ type: "text", text: "Run the task" }],
  budget: { timeoutMs: 30_000, maxToolCalls: 8 },
});
```

`maxToolCalls: 0` disables tool calls. The deadline starts when the request enters the Loop and includes
FIFO waiting, capability loading, approvals, and execution. Cancellation is cooperative: stop dispatch,
propagate `AbortSignal`, and join started work before returning. Expired queued requests do not execute,
but wait for preceding work to release the FIFO. Implementations ignoring the signal can delay return
and shutdown. Budget errors are `ExecutionBudgetExceededError` with `budget`, `limit`, and
`code: "EXECUTION_BUDGET_EXCEEDED"`. Deadline expiry cancels a Run; tool-count exhaustion fails it.
The round limit retains its existing failure behavior without an automatic final summary.

`runtime.close()` cancels and joins work. It never closes injected stores, models, tools, or MCP connections.
Close the Runtime first, then close those host-owned resources. Manual `AgentLoop` / `AgentRuntime`
composition remains available for advanced integrations.

### Run with a real model

The HTTP example uses OpenRouter and defaults to a local SQLite database.

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY in .env; optionally change the model IDs.
npm run build
node --env-file=.env dist/examples/runtime-server.js
```

The example reads process environment variables; `.env` is loaded by the explicit `--env-file` flag.
If variables are already exported in your shell, `npm run runtime` also builds and starts the server.

From another terminal:

```bash
node dist/src/channel/cli/main.js --session demo
```

Or send a request directly:

```bash
curl -N http://127.0.0.1:8787/v1/turn \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo","userInput":"Hello, Wayline."}'
```

`POST /v1/turn` creates a missing session and streams newline-delimited JSON events followed by a
result or error. Reusing the session ID continues its stored conversation. `GET /health` returns
`{"ok":true}`. The CLI accepts `--url` and `--session`; enter `/exit` to leave it.

The HTTP adapter is intended for trusted development use: it binds to loopback by default and has no
authentication. Public deployments need host-owned authentication, tenant routing, Host validation,
and rate limits. The example registers conversation compression, but does not register shell execution.

## Configure persistence

The HTTP example accepts these environment variables:

| Variable | Purpose / default |
| --- | --- |
| `OPENROUTER_API_KEY` | Required for the real-model example |
| `OPENROUTER_MODEL` | Main model; default `anthropic/claude-opus-4.6` |
| `OPENROUTER_SUMMARY_MODEL` | Compression model; default `openai/gpt-4.1-mini` |
| `AGENT_RUNTIME_HOST` / `AGENT_RUNTIME_PORT` | Listen address; default `127.0.0.1:8787` |
| `AGENT_DATABASE_MODE` | `auto`, `postgres`, `supabase`, or `sqlite`; default `auto` |
| `AGENT_DATABASE_NAMESPACE` | PostgreSQL session namespace; default `runtime-server` |
| `AGENT_SQLITE_PATH` | SQLite file; default `.agent-data/runtime.sqlite` |
| `AGENT_POSTGRES_URL` | PostgreSQL runtime connection string |
| `SUPABASE_DATABASE_URL` | Supabase PostgreSQL database connection string |
| `AGENT_DATABASE_SCHEMA_MODE` | Remote schema handling: `check` (default) or explicit `migrate` |
| `AGENT_POSTGRES_MIGRATION_URL` / `SUPABASE_MIGRATION_URL` | Optional separate migration connection |

In `auto` mode, the selection order is **PostgreSQL → Supabase → SQLite**. All declared profiles must
be valid. A connection failure stops startup; it does not silently switch stores. Selecting a different
backend does not migrate existing data.

For an embedded application, open the store explicitly:

```js
import { openSessionStore } from "wayline-agent-runtime/storage";

const sessionStore = await openSessionStore({
  namespace: "my-agent",
  sqlite: { filename: ".agent-data/my-agent.sqlite" },
});
// Pass sessionStore to AgentLoop.
// During shutdown, await runtime.close() before await sessionStore.close().
```

PostgreSQL-backed stores use the private `agent_runtime` schema. Startup checks schema readiness by
default; apply migrations explicitly with `migratePostgresSchema` or a deliberate `schemaMode: "migrate"`
setup step. Separate migration and runtime roles require explicit runtime-role grants.

The Supabase profile takes a PostgreSQL database URL, not a Data API URL or API key. It defaults to TLS
unless the connection URL configures TLS itself. See [storage architecture](./ARCHITECTURE.md) for
migration, permissions, TLS, and lifecycle details.

Each process needs its own file or SQLite store. Multiple processes may use one PostgreSQL database
only with disjoint ownership: **at most one process may own a `(namespace, session ID)` pair**.
Version checks do not provide distributed scheduling or cross-process locking for tool effects.

## Public API and adapters

| Import | Contents |
| --- | --- |
| `wayline-agent-runtime` | `AgentRuntime`, `AgentLoop`, model/session contracts, skills, `ToolRegistry` |
| `wayline-agent-runtime/acp` | `createAcpAgent`, `AcpPermissionBridge` |
| `wayline-agent-runtime/channel` | Channel runtime, HTTP server/client, channel contracts |
| `wayline-agent-runtime/provider` | OpenRouter and AI SDK provider adapters |
| `wayline-agent-runtime/storage` | File, SQLite, PostgreSQL stores, configuration and migrations |
| `wayline-agent-runtime/tools` | Tool contracts, optional Bash and conversation compression |
| `wayline-agent-runtime/mcp` | MCP tool adaptation, refresh, and lifecycle |
| `wayline-agent-runtime/legacy` | Deprecated `ToolExecutor` compatibility API |

### ACP: clients control the agent

The adapter uses `@agentclientprotocol/sdk` for stable ACP v1. It supports initialization,
session creation/resume/deletion, prompts, cancellation, ordered text/tool updates, and optional
client-side permission requests. The embedding host supplies the transport and closes the runtime.

`workspaceRoot` must match the root enforced by the host's tools or sandbox. ACP sessions carry a
protected workspace binding; knowing a session ID does not authorize another adapter to use it.
Use the same `AcpPermissionBridge` instance in the loop and ACP adapter when forwarding approvals.

The adapter reports `loadSession: false`. Replay/load, `session/close`, additional workspace
directories, ACP-managed MCP server lifecycles, and image/audio/embedded-resource prompts are not
implemented. Text and baseline resource links are accepted. Full contracts are in
[ARCHITECTURE.md](./ARCHITECTURE.md).

### Tools, MCP, and skills

Register implementations in the host, then select capability names at runtime, session, or turn scope.
Prompts cannot install executable tools. Skills supply instructions; MCP supplies tools; ACP exposes
the agent to its client.

Read-only tools receive immutable session snapshots. Trusted session-writing tools execute exclusively.
Tools with ordered external side effects should also use `executionPolicy: "exclusive"`.
MCP tools require approval and run exclusively by default; trusting server annotations is a host opt-in.
The optional `BashTool` requires approval for every command and is not an OS sandbox.

## Execution guarantees

- Turns and explicit recovery share one FIFO per session within a process; different sessions can run
  concurrently.
- Tool outcomes are checkpointed before the next model step. Recovery does not automatically repeat a
  tool left with an unknown external outcome. External effects are not guaranteed exactly once.
- Cancellation is cooperative. Shutdown stops new admissions and waits for started work; tools and
  providers must observe their `AbortSignal` for prompt shutdown.
- Session saves are version-checked updates. A stale save cannot recreate a deleted session. An
  outcome-unknown save requires reloading state before reconciliation.
- Progress events are immutable, best-effort projections. Observers cannot change canonical state or
  block execution; transport adapters own ordered delivery and backpressure.
- The host owns managed store resources and closes them after the runtime drains its work.

## Development

```bash
npm run check       # Lint, type-check, tests, and coverage gates
npm pack --dry-run  # Build and inspect the distributable package
```

Use `npm test` for tests without coverage, or `npm run lint` and `npm run typecheck` independently.
Coverage gates are 85% lines/statements, 75% branches, and 80% functions. CI covers Node.js 22.13,
24, and 26, plus PostgreSQL 15 and 17. Local PostgreSQL contract tests require `TEST_POSTGRES_URL`;
without it, those database tests are skipped.

```text
src/agent-runtime.ts   Session lifecycle and capability selection
src/agent-loop.ts      Model/tool loop and mutation coordination
src/runtime/           Execution, retry, recovery, steering, events
src/acp/               ACP adapter and permissions
src/channel/           HTTP, CLI, and channel adapters
src/provider/          Model provider integrations
src/storage/           Store selection, migrations, and database lifecycle
src/tools/             Local capabilities
src/mcp.ts             MCP tool adapter
src/session*.ts        Session contracts and local stores
examples/              Minimal and HTTP examples
tests/                 Unit, integration, and protocol tests
```

Read [AGENT.md](./AGENT.md) before changing execution or ownership semantics, and keep
[ARCHITECTURE.md](./ARCHITECTURE.md) aligned with changes to runtime guarantees.

## Origin and license

Wayline Agent Runtime is derived from [42 Agent](https://github.com/42-club/42-agent).
This repository preserves upstream Git history and the [Apache-2.0 license](./LICENSE).
The Wayline adaptation updates package identity, repository links, default display names, and documentation.
Existing storage-format identifiers are retained for compatibility with upstream session data.
