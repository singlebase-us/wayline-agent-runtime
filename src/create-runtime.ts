import { AgentLoop, type AgentLoopConfig } from "./agent-loop.js";
import { AgentRuntime } from "./agent-runtime.js";
import type { ModelClient } from "./model.js";
import type { AgentLoopEventHandler } from "./runtime/events.js";
import { InMemorySessionStore, type SessionStore } from "./session.js";
import type { SkillLoader } from "./skills.js";
import { ToolRegistry, type ApprovalHandler, type Tool } from "./tools/base.js";
import { BashTool, type BashToolOptions } from "./tools/bash.js";
import { ConversationCompressionTool, type CompressionOptions } from "./tools/compression.js";

export interface CreateRuntimeOptions {
  model: ModelClient;
  /** Uses model when omitted. Supply a cheaper model to reduce compression costs. */
  summarizer?: ModelClient;
  /** Required when the built-in Bash tool is enabled. This is a cwd, not a sandbox. */
  workspaceRoot?: string;
  /** Host-owned; runtime.close() never closes an injected Store. Defaults to memory. */
  sessionStore?: SessionStore;
  /** Defaults to denial. Every built-in Bash execution requires host approval. */
  requestApproval?: ApprovalHandler;
  skillLoader?: SkillLoader;
  onEvent?: AgentLoopEventHandler;
  /** Defaults: 16 rounds, 64 tool calls, and a cooperative 5-minute deadline. */
  config?: AgentLoopConfig;
  builtins?: {
    bash?: false | Omit<BashToolOptions, "defaultCwd">;
    compression?: false | CompressionOptions;
  };
  /** Additional tools. Duplicate names fail instead of silently replacing capabilities. */
  tools?: readonly Tool[];
  /** Explicit replacements for registered tools; names must already exist. */
  replaceTools?: readonly Tool[];
}

/** Recommended entry point; uses the same Loop and lifecycle as manual construction. */
export function createRuntime(options: CreateRuntimeOptions): AgentRuntime {
  const tools = new ToolRegistry();
  if (options.builtins?.bash !== false) {
    if (!options.workspaceRoot?.trim()) {
      throw new TypeError("workspaceRoot is required when the built-in Bash tool is enabled");
    }
    tools.register(new BashTool({ ...options.builtins?.bash, defaultCwd: options.workspaceRoot }));
  }
  if (options.builtins?.compression !== false) {
    tools.register(new ConversationCompressionTool(
      options.summarizer ?? options.model,
      options.builtins?.compression,
    ));
  }
  for (const tool of options.tools ?? []) tools.register(tool);
  const replaced = new Set<string>();
  for (const tool of options.replaceTools ?? []) {
    if (!tools.has(tool.name) || replaced.has(tool.name)) {
      throw new Error(`Tool replacement requires a unique registered name: ${tool.name}`);
    }
    tools.register(tool, { replace: true });
    replaced.add(tool.name);
  }
  return new AgentRuntime({
    loop: new AgentLoop({
      model: options.model,
      sessionStore: options.sessionStore ?? new InMemorySessionStore(),
      tools,
      requestApproval: options.requestApproval ?? (async () => false),
      skillLoader: options.skillLoader,
      config: {
        ...options.config,
        maxToolRounds: options.config?.maxToolRounds ?? 16,
        maxToolCalls: options.config?.maxToolCalls ?? 64,
        timeoutMs: options.config?.timeoutMs ?? 300_000,
      },
    }),
    onEvent: options.onEvent,
  });
}
