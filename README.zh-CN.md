# Wayline Agent Runtime

[English](./README.md) · [架构说明](./ARCHITECTURE.md) · [示例](./examples) · [开发约定](./AGENT.md)

可嵌入应用的 TypeScript Agent 运行时，负责模型与工具循环、会话持久化和执行生命周期。
Wayline 将执行过程保存在服务端，通过 ACP、HTTP 或自定义适配器接入应用；模型、能力和部署策略由宿主提供。

## 核心能力

- **会话生命周期**：通过 `AgentRuntime` 创建会话、提交提示、订阅进度、引导运行、取消任务和关闭运行时。
- **持久化执行**：保存消息、运行状态和工具调用结果，支持内存、文件、SQLite 和 PostgreSQL；Supabase 配置复用 PostgreSQL 引擎。
- **可控并发**：同一会话按 FIFO 顺序执行，不同会话可并发；工具支持有界并行以及用于有序操作的独占执行。
- **接入能力**：基于官方 SDK 的 ACP v1 适配器、HTTP 开发服务和 CLI、OpenRouter 与 AI SDK 提供商适配器、本地工具、MCP 工具及文件型 Skills。
- **保守恢复**：在模型和工具边界保存检查点；发生中断后，不自动重放外部执行结果不明的工具调用。

一个进程承载一个独立 Agent 运行时。应用可以协调多个进程；Agent 发现、任务拆分、调度、身份认证、多租户和产品界面由上层应用负责。

```text
业务应用 / 编排器
      │
      ├── ACP 客户端 ──► Wayline 进程 A ──► Store A
      └── ACP 客户端 ──► Wayline 进程 B ──► Store B

每个进程内部：
ACP / HTTP / 自定义适配器
      │
 AgentRuntime
      │
  AgentLoop ──► 模型提供商
      ├───────► ToolRegistry / MCP / Skills
      └───────► SessionStore
```

## 快速开始

需要 **Node.js 22.13.0 或更新版本**及 npm。

```bash
git clone https://github.com/singlebase-us/wayline-agent-runtime.git
cd wayline-agent-runtime
npm ci
npm run example
```

示例使用内存存储和本地回显模型，无需 API Key，运行后输出 `收到：你好`。

### 嵌入应用

执行 `npm run build` 后，将以下内容保存为仓库根目录下的 `demo.mjs`，再运行 `node demo.mjs`。
示例中的包名通过仓库自身的 package exports 解析。

```js
import {
  AgentLoop,
  AgentRuntime,
  InMemorySessionStore,
  ToolRegistry,
} from "wayline-agent-runtime";

const runtime = new AgentRuntime({
  loop: new AgentLoop({
    model: {
      async complete({ messages }) {
        return { content: `收到：${messages.at(-1)?.content ?? ""}` };
      },
    },
    tools: new ToolRegistry(),
    sessionStore: new InMemorySessionStore(),
    requestApproval: async () => false,
  }),
});

try {
  await runtime.createSession({ sessionId: "demo" });
  const result = await runtime.prompt({
    sessionId: "demo",
    content: [{ type: "text", text: "你好，Wayline。" }],
  });
  console.log(result.content.map((part) => part.text).join(""));
} finally {
  await runtime.close();
}
```

如果要在另一个本地项目中使用，先在本仓库执行 `npm pack`，再到目标项目安装生成的 tarball。
以上步骤直接使用仓库构建产物，不依赖已发布的 npm 包。

### 接入真实模型

HTTP 示例通过 OpenRouter 调用模型，默认使用本地 SQLite 数据库。

```bash
cp .env.example .env
# 在 .env 中填写 OPENROUTER_API_KEY，并按需修改模型 ID。
npm run build
node --env-file=.env dist/examples/runtime-server.js
```

示例读取进程环境变量，以上命令通过 `--env-file` 显式加载 `.env`。
如果已经在 shell 中导出环境变量，也可直接执行 `npm run runtime` 完成构建和启动。

在另一个终端连接 CLI：

```bash
node dist/src/channel/cli/main.js --session demo
```

也可以直接发送 HTTP 请求：

```bash
curl -N http://127.0.0.1:8787/v1/turn \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo","userInput":"你好，Wayline。"}'
```

`POST /v1/turn` 会按需创建会话，以逐行 JSON 返回事件，最后输出结果或错误。
复用同一会话 ID 可继续已有对话。`GET /health` 返回 `{"ok":true}`。
CLI 支持 `--url` 和 `--session`，输入 `/exit` 退出。

HTTP 适配器面向可信开发环境，默认仅监听本机回环地址，不提供身份认证。
对外部署时，认证、租户路由、Host 校验和限流应由宿主应用实现。
示例注册了对话压缩工具，没有注册 shell 执行能力。

## 配置持久化

HTTP 示例读取以下环境变量：

| 变量 | 用途 / 默认值 |
| --- | --- |
| `OPENROUTER_API_KEY` | 真实模型示例必填 |
| `OPENROUTER_MODEL` | 主模型，默认 `anthropic/claude-opus-4.6` |
| `OPENROUTER_SUMMARY_MODEL` | 压缩模型，默认 `openai/gpt-4.1-mini` |
| `AGENT_RUNTIME_HOST` / `AGENT_RUNTIME_PORT` | 监听地址，默认 `127.0.0.1:8787` |
| `AGENT_DATABASE_MODE` | `auto`、`postgres`、`supabase` 或 `sqlite`，默认 `auto` |
| `AGENT_DATABASE_NAMESPACE` | PostgreSQL 会话命名空间，默认 `runtime-server` |
| `AGENT_SQLITE_PATH` | SQLite 文件，默认 `.agent-data/runtime.sqlite` |
| `AGENT_POSTGRES_URL` | PostgreSQL 运行时连接字符串 |
| `SUPABASE_DATABASE_URL` | Supabase 的 PostgreSQL 数据库连接字符串 |
| `AGENT_DATABASE_SCHEMA_MODE` | 远程数据库 schema 策略：默认 `check`，显式迁移用 `migrate` |
| `AGENT_POSTGRES_MIGRATION_URL` / `SUPABASE_MIGRATION_URL` | 可选的独立迁移连接 |

`auto` 模式按 **PostgreSQL → Supabase → SQLite** 的顺序选择。
所有声明的配置都必须有效；选定后连接失败会终止启动，不会静默切换存储。
切换后端不会自动迁移已有数据。

嵌入应用时，可显式打开存储：

```js
import { openSessionStore } from "wayline-agent-runtime/storage";

const sessionStore = await openSessionStore({
  namespace: "my-agent",
  sqlite: { filename: ".agent-data/my-agent.sqlite" },
});
// 将 sessionStore 传入 AgentLoop。
// 关闭时，先 await runtime.close()，再 await sessionStore.close()。
```

PostgreSQL 存储使用私有 `agent_runtime` schema，启动时默认检查其就绪状态。
迁移应通过 `migratePostgresSchema` 或明确配置 `schemaMode: "migrate"` 的初始化步骤执行。
如果迁移角色与运行时角色不同，还需显式授予运行时角色所需权限。

Supabase 配置接受 PostgreSQL 数据库 URL，不接受 Data API URL 或 API Key。
除非连接 URL 自身配置了 TLS，否则该配置默认启用 TLS。
迁移、权限、TLS 与资源生命周期详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

每个进程应使用独立的文件或 SQLite 存储。多个进程可共用一个 PostgreSQL 数据库，但必须划分所有权：
**同一 `(namespace, session ID)` 同时最多由一个进程拥有**。
版本检查不提供分布式调度，也不提供工具副作用的跨进程互斥。

## 公共接口与适配器

| 导入路径 | 内容 |
| --- | --- |
| `wayline-agent-runtime` | `AgentRuntime`、`AgentLoop`、模型与会话契约、Skills、`ToolRegistry` |
| `wayline-agent-runtime/acp` | `createAcpAgent`、`AcpPermissionBridge` |
| `wayline-agent-runtime/channel` | Channel 运行时、HTTP 服务端与客户端、Channel 契约 |
| `wayline-agent-runtime/provider` | OpenRouter 与 AI SDK 提供商适配器 |
| `wayline-agent-runtime/storage` | 文件、SQLite、PostgreSQL 存储、配置与迁移 |
| `wayline-agent-runtime/tools` | 工具契约、可选 Bash 工具、对话压缩 |
| `wayline-agent-runtime/mcp` | MCP 工具适配、刷新及生命周期 |
| `wayline-agent-runtime/legacy` | 已弃用的 `ToolExecutor` 兼容接口 |

### ACP：客户端控制 Agent

适配器使用 `@agentclientprotocol/sdk` 实现稳定版 ACP v1，支持初始化、会话创建/恢复/删除、提示、
取消、有序文本与工具更新，以及可选的客户端权限请求。传输层和运行时关闭由宿主负责。

`workspaceRoot` 必须与宿主工具或沙箱实际约束的根目录一致。
ACP 会话具有受保护的工作区绑定，仅知道会话 ID 不能获得其他适配器的访问权限。
向客户端转发审批时，Loop 与 ACP 适配器应使用同一个 `AcpPermissionBridge` 实例。

适配器明确报告 `loadSession: false`。目前未实现回放/加载、`session/close`、额外工作区目录、
由 ACP 管理的 MCP 服务生命周期，以及图片/音频/嵌入资源提示块；支持文本与基础资源链接。
完整契约见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

### 工具、MCP 与 Skills

由宿主注册实现，再在运行时、会话或单轮作用域中选择能力名称。提示内容不能安装可执行工具。
Skills 提供指令，MCP 提供工具，ACP 将 Agent 暴露给客户端。

只读工具获得不可变的会话快照；可信的会话写入工具独占执行。
需要保持外部副作用顺序的工具也应使用 `executionPolicy: "exclusive"`。
MCP 工具默认需要审批并独占执行，是否信任服务端注解由宿主显式决定。
可选的 `BashTool` 对每条命令要求审批，本身不构成操作系统沙箱。

## 执行保证

- 同一进程内，每个会话的提示和显式恢复共用 FIFO 队列；不同会话可以并发。
- 工具结果在下一次模型调用前写入检查点。恢复时不自动重试外部结果不明的工具，也不承诺外部副作用恰好执行一次。
- 取消是协作式的。关闭会阻止新任务并等待已启动工作结束；工具与提供商应响应 `AbortSignal`。
- 会话保存使用版本检查和仅更新语义，过期保存不能重建已删除会话。保存结果不明时，应重新加载后再协调状态。
- 进度事件是不可变、尽力交付的投影，观察者不能修改真实状态或阻塞执行；有序投递与背压由适配器负责。
- 托管存储资源由宿主拥有，在运行时完成关闭后释放。

## 开发与验证

```bash
npm run check       # Lint、类型检查、测试及覆盖率门槛
npm pack --dry-run  # 构建并检查发布包内容
```

仅运行测试可使用 `npm test`，也可分别执行 `npm run lint` 和 `npm run typecheck`。
覆盖率门槛为行/语句 85%、分支 75%、函数 80%。CI 覆盖 Node.js 22.13、24、26，以及 PostgreSQL 15、17。
本地 PostgreSQL 契约测试需要 `TEST_POSTGRES_URL`，未配置时相应数据库测试会跳过。

```text
src/agent-runtime.ts   会话生命周期与能力选择
src/agent-loop.ts      模型/工具循环及状态变更协调
src/runtime/           执行、重试、恢复、引导、事件
src/acp/               ACP 适配器与权限桥接
src/channel/           HTTP、CLI 与 Channel 适配器
src/provider/          模型提供商集成
src/storage/           存储选择、迁移及数据库生命周期
src/tools/             本地能力
src/mcp.ts             MCP 工具适配
src/session*.ts        会话契约及本地存储
examples/              最小示例与 HTTP 示例
tests/                 单元、集成及协议测试
```

修改执行或所有权语义前，请阅读 [AGENT.md](./AGENT.md)；运行时保证发生变化时，同步更新
[ARCHITECTURE.md](./ARCHITECTURE.md)。

## 来源与许可证

Wayline Agent Runtime 基于 [42 Agent](https://github.com/42-club/42-agent)，保留上游 Git 历史和
[Apache-2.0 许可证](./LICENSE)。Wayline 版本更新了包标识、仓库链接、默认展示名称和项目文档。
为兼容上游会话数据，已有存储格式标识保持不变。
