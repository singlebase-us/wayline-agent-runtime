import {
  createRuntime,
  type ModelClient,
} from "../src/index.js";

const model: ModelClient = {
  async complete({ messages }) {
    return { content: `收到：${messages.at(-1)?.content ?? ""}` };
  },
};

const runtime = createRuntime({
  model,
  workspaceRoot: process.cwd(),
  requestApproval: async () => false,
});
try {
  await runtime.createSession({ sessionId: "demo" });
  const result = await runtime.prompt({
    sessionId: "demo",
    content: [{ type: "text", text: "你好" }],
  });
  console.log(result.content.map((part) => part.text).join(""));
} finally {
  await runtime.close();
}
