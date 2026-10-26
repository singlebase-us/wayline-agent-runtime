import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntime,
  InMemorySessionStore,
  type Tool,
  type ModelClient,
} from "../src/index.js";

const echo: ModelClient = { async complete({ messages }) { return { content: messages.at(-1)?.content }; } };
const custom: Tool = {
  name: "lookup", description: "Look up a value", inputSchema: { type: "object" },
  async execute() { return { value: 42 }; },
};

test("createRuntime exposes both built-ins and executes an external tool", async () => {
  let calls = 0;
  const runtime = createRuntime({
    workspaceRoot: process.cwd(), tools: [custom],
    model: { async complete() {
      return calls++ === 0
        ? { toolCalls: [{ id: "lookup-1", name: "lookup", arguments: {} }] }
        : { content: "answer" };
    } },
  });
  try {
    assert.deepEqual((await runtime.capabilities()).tools.map((tool) => tool.name), [
      "bash", "compress_conversation", "lookup",
    ]);
    const result = await runtime.prompt({ sessionId: "s", createIfMissing: true, content: [{ type: "text", text: "go" }] });
    assert.equal(result.content[0]?.text, "answer");
  } finally { await runtime.close(); }
});

test("factory Bash denies execution without a host approval handler", async () => {
  const store = new InMemorySessionStore();
  let calls = 0;
  const runtime = createRuntime({
    workspaceRoot: process.cwd(), sessionStore: store,
    model: { async complete() {
      return calls++ === 0
        ? { toolCalls: [{ id: "shell", name: "bash", arguments: { command: "echo should-not-run" } }] }
        : { content: "done" };
    } },
  });
  try {
    await runtime.prompt({ sessionId: "s", createIfMissing: true, content: [{ type: "text", text: "go" }] });
    assert.deepEqual((await store.get("s"))?.runState?.toolCalls[0]?.result, { approved: false, executed: false });
  } finally { await runtime.close(); }
});

test("factory supports disabling built-ins, explicit replacements and host-owned stores", async () => {
  let closed = false;
  const store = Object.assign(new InMemorySessionStore(), { async close() { closed = true; } });
  const runtime = createRuntime({
    model: echo, sessionStore: store,
    builtins: { bash: false, compression: false }, tools: [custom],
    replaceTools: [{ ...custom, description: "replacement" }],
  });
  assert.equal((await runtime.capabilities()).tools[0]?.description, "replacement");
  assert.throws(() => runtime.registerTool(custom), /already registered/);
  runtime.registerTool(custom, { replace: true });
  assert.equal((await runtime.capabilities()).tools[0]?.description, custom.description);
  assert.throws(() => runtime.registerTool({ ...custom, inputSchema: { type: "invalid" } }, { replace: true }));
  assert.equal((await runtime.capabilities()).tools[0]?.description, custom.description);
  assert.equal(runtime.unregisterTool("lookup"), true);
  assert.equal(runtime.unregisterTool("lookup"), false);
  await runtime.close();
  assert.equal(closed, false);
  assert.throws(() => runtime.registerTool(custom), { name: "RuntimeClosedError" });
  assert.throws(() => runtime.unregisterTool("lookup"), { name: "RuntimeClosedError" });
});

test("factory rejects ambiguous tools and requires a Bash working directory", () => {
  assert.throws(() => createRuntime({ model: echo }), /workspaceRoot/);
  assert.throws(() => createRuntime({ model: echo, workspaceRoot: ".", tools: [{ ...custom, name: "bash" }] }), /already registered/);
  assert.throws(() => createRuntime({ model: echo, workspaceRoot: ".", replaceTools: [custom] }), /registered name/);
  assert.throws(() => createRuntime({ model: echo, workspaceRoot: ".", tools: [custom], replaceTools: [custom, custom] }), /unique/);
});

test("replacing a tool affects later Turns while the active Turn keeps its snapshot", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const runtime = createRuntime({
    builtins: { bash: false, compression: false }, tools: [custom],
    model: { async complete({ messages }) {
      if (messages.at(-1)?.role === "tool") return { content: messages.at(-1)?.content };
      if (first) { first = false; started(); await gate; }
      return { toolCalls: [{ id: "lookup", name: "lookup", arguments: {} }] };
    } },
  });
  try {
    const pending = runtime.prompt({ sessionId: "s", createIfMissing: true, content: [{ type: "text", text: "first" }] });
    await ready;
    runtime.registerTool({ ...custom, async execute() { return { value: 99 }; } }, { replace: true });
    release();
    assert.equal((await pending).content[0]?.text, '{"value":42}');
    const next = await runtime.prompt({ sessionId: "s", content: [{ type: "text", text: "next" }] });
    assert.equal(next.content[0]?.text, '{"value":99}');
  } finally { release(); await runtime.close(); }
});
