import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentLoop, createRuntime, ExecutionBudgetExceededError, InMemorySessionStore, ToolRegistry,
  type Tool, type ModelClient,
} from "../src/index.js";

const input = { sessionId: "s", createIfMissing: true, content: [{ type: "text" as const, text: "go" }] };
const builtins = { bash: false as const, compression: false as const };
const call = (id: string) => ({ id, name: "effect", arguments: {} });
const tool = (execute: Tool["execute"]): Tool => ({ name: "effect", description: "", inputSchema: { type: "object" }, execute });
const isBudgetError = (budget: "maxToolCalls" | "timeoutMs") => (error: unknown) =>
  error instanceof ExecutionBudgetExceededError && error.budget === budget;

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("tool budget rejects an entire batch before any tool or orphan call is persisted", async () => {
  const store = new InMemorySessionStore();
  let executions = 0;
  const runtime = createRuntime({
    builtins, sessionStore: store, config: { maxToolCalls: 1 },
    tools: [tool(async () => { executions++; })],
    model: { async complete() { return { toolCalls: [call("a"), call("b")] }; } },
  });
  try {
    await assert.rejects(runtime.prompt({ ...input, budget: { maxToolCalls: 100 } }), isBudgetError("maxToolCalls"));
    assert.equal(executions, 0);
    const session = await store.get("s");
    assert.equal(session?.runState?.status, "failed");
    assert.deepEqual(session?.runState?.toolCalls, []);
    assert.deepEqual(session?.messages.map((m) => m.role), ["user"]);
  } finally { await runtime.close(); }
});

test("tool budgets accumulate across rounds, reset per request, and allow a final answer", async () => {
  let executions = 0;
  let modelCalls = 0;
  const runtime = createRuntime({
    builtins, config: { maxToolCalls: 1 }, tools: [tool(async () => ++executions)],
    model: { async complete() {
      modelCalls++;
      return modelCalls === 4 ? { content: "done" } : { toolCalls: [call(String(modelCalls))] };
    } },
  });
  try {
    await assert.rejects(runtime.prompt(input), isBudgetError("maxToolCalls"));
    assert.equal(executions, 1);
    assert.equal((await runtime.prompt(input)).content[0]?.text, "done");
    assert.equal(executions, 2);
  } finally { await runtime.close(); }
});

test("a tighter request budget may disable tools without disabling text responses", async () => {
  let useTool = true;
  const runtime = createRuntime({
    builtins, tools: [tool(async () => assert.fail("tool must not execute"))],
    model: { async complete() { return useTool ? { toolCalls: [call("a")] } : { content: "text" }; } },
  });
  try {
    await assert.rejects(runtime.prompt({ ...input, budget: { maxToolCalls: 0 } }), isBudgetError("maxToolCalls"));
    useTool = false;
    assert.equal((await runtime.prompt({ ...input, budget: { maxToolCalls: 0 } })).content[0]?.text, "text");
  } finally { await runtime.close(); }
});

test("deadline aborts started tools, joins their settlement, and prevents later dispatch", async () => {
  const started = barrier();
  const release = barrier();
  let signal: AbortSignal | undefined;
  let executions = 0;
  const runtime = createRuntime({
    builtins, config: { timeoutMs: 40 },
    tools: [{ ...tool(async (_args, context) => {
      executions++; signal = context.signal; started.resolve(); await release.promise; return "settled";
    }), executionPolicy: "exclusive" }],
    model: { async complete() { return { toolCalls: [call("a"), call("b")] }; } },
  });
  let settled = false;
  const turn = runtime.prompt(input);
  const checked = assert.rejects(turn, isBudgetError("timeoutMs")).then(() => { settled = true; });
  try {
    await started.promise;
    await delay(60);
    assert.equal(signal?.aborted, true);
    assert.equal(settled, false);
    assert.equal(runtime.steer("s", "too late"), false);
    release.resolve();
    await checked;
    assert.equal(executions, 1);
  } finally { release.resolve(); await checked; await runtime.close(); }
});

test("queued request timeout includes FIFO waiting and never appends its input", async () => {
  const started = barrier();
  const release = barrier();
  const store = new InMemorySessionStore();
  const runtime = createRuntime({
    builtins, sessionStore: store,
    model: { async complete() { started.resolve(); await release.promise; return { content: "done" }; } },
  });
  const first = runtime.prompt(input);
  try {
    await started.promise;
    const queued = assert.rejects(runtime.prompt({ ...input, budget: { timeoutMs: 10 } }), isBudgetError("timeoutMs"));
    await delay(30);
    release.resolve();
    await first;
    await queued;
    assert.deepEqual((await store.get("s"))?.messages.map((m) => m.content), ["go", "done"]);
  } finally { release.resolve(); await first; await runtime.close(); }
});

test("deadline covers skill preflight without creating a session", async () => {
  const store = new InMemorySessionStore();
  const runtime = createRuntime({
    builtins, sessionStore: store, config: { timeoutMs: 10 },
    skillLoader: { async load(names) {
      await delay(30);
      return names.map((name) => ({ name, description: "", instructions: "", path: "" }));
    } },
    model: { async complete() { assert.fail("model must not run"); } },
  });
  try {
    await assert.rejects(runtime.prompt({ ...input, skills: ["slow"] }), isBudgetError("timeoutMs"));
    assert.equal(await store.get("s"), undefined);
  } finally { await runtime.close(); }
});

test("automatic compression consumes the same request tool budget", async () => {
  const store = new InMemorySessionStore();
  const session = await store.create("s");
  session.messages.push({ role: "user", content: "old" }, { role: "assistant", content: "old answer" });
  await store.save(session);
  let summaries = 0;
  const runtime = createRuntime({
    builtins: { bash: false, compression: { retainRecent: 1, preserveRecentTokens: 0 } },
    sessionStore: store, config: { maxToolCalls: 1, compressionThreshold: 2 },
    summarizer: { async complete() { summaries++; return { content: "summary" }; } },
    tools: [tool(async () => assert.fail("budget already consumed"))],
    model: { async complete() { return { toolCalls: [call("a")] }; } },
  });
  try {
    await assert.rejects(runtime.prompt(input), isBudgetError("maxToolCalls"));
    assert.equal(summaries, 1);
    assert.equal((await store.get("s"))?.messages[0]?.metadata?.kind, "conversation_summary");
  } finally { await runtime.close(); }
});

test("cancellation from the started observer prevents actual tool execution", async () => {
  const store = new InMemorySessionStore();
  const runtime = createRuntime({
    builtins, sessionStore: store, tools: [tool(async () => assert.fail("cancelled tool started"))],
    model: { async complete() { return { toolCalls: [call("a")] }; } },
  });
  let executed = false;
  runtime.registerTool(tool(async () => { executed = true; }), { replace: true });
  try {
    await assert.rejects(runtime.prompt({ ...input, onEvent(event) {
      if (event.type === "tool_call_started") assert.equal(runtime.cancel("s"), true);
    } }), { name: "AbortError" });
    assert.equal(executed, false);
    assert.equal((await store.get("s"))?.runState?.toolCalls[0]?.status, "interrupted");
  } finally { await runtime.close(); }
});

test("direct Loop requests enforce budgets and release successful deadline timers", async () => {
  let signal: AbortSignal | undefined;
  const model: ModelClient = { async complete(request) { signal = request.signal; return { content: "ok" }; } };
  const loop = new AgentLoop({ model, sessionStore: new InMemorySessionStore(), tools: new ToolRegistry(), requestApproval: async () => false });
  assert.equal(await loop.runTurn({ sessionId: "s", userInput: "go", budget: { timeoutMs: 10, maxToolCalls: 0 } }), "ok");
  await delay(25);
  assert.equal(signal?.aborted, false);
  for (const budget of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 }, { maxToolCalls: -1 }, { maxToolCalls: 0.5 }]) {
    await assert.rejects(loop.runTurn({ sessionId: "s", userInput: "go", budget }), RangeError);
    assert.throws(() => createRuntime({ model, builtins, config: budget }), RangeError);
  }
  assert.throws(() => createRuntime({ model, builtins, config: { maxToolRounds: 0 } }), RangeError);
});

test("request timeout cannot extend the configured ceiling or accept a late model result", async () => {
  const store = new InMemorySessionStore();
  const runtime = createRuntime({
    builtins, sessionStore: store, config: { timeoutMs: 10 },
    model: { async complete() { await delay(30); return { content: "late" }; } },
  });
  try {
    await assert.rejects(runtime.prompt({ ...input, budget: { timeoutMs: 1_000 } }), isBudgetError("timeoutMs"));
    assert.equal((await store.get("s"))?.runState?.status, "cancelled");
    assert.deepEqual((await store.get("s"))?.messages.map((m) => m.role), ["user"]);
  } finally { await runtime.close(); }
});
