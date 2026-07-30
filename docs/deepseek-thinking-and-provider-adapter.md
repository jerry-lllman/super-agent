# DeepSeek thinking 模式与 Provider Adapter 兼容问题

> 记录本项目接入 DeepSeek v4 时踩到的"多轮工具调用 400"问题的完整分析、解决方案，以及背后的工程经验。

---

## 1. 问题现象

使用 `@ai-sdk/openai` 调用 DeepSeek v4 系列模型（`deepseek-v4-flash` / `deepseek-v4-pro`），在 **多轮对话 + 工具调用** 场景下，第二轮请求开始稳定出现 400：

```
The reasoning_content in the thinking mode must be passed back to the API.
```

也可能表现为 `AI_NoOutputGeneratedError`——AI SDK 在最终结果阶段没拿到任何输出 part 时会抛这个错误，常见原因之一就是上游 400 的 error part 没被业务层正确暴露，但也可能是服务端真的返回了空 stream。

---

## 2. 根本原因

涉及四个环节，缺一不可：

### 2.1 推理模型会返回 `reasoning_content`

DeepSeek v4 默认开启 thinking 模式，响应里除了 `content` / `tool_calls`，还会带一个 OpenAI 协议**没有**的扩展字段：

```json
{
  "role": "assistant",
  "content": null,
  "reasoning_content": "用户想读 package.json，我应该调用 read_file...",
  "tool_calls": [{ "name": "read_file", "arguments": "..." }]
}
```

### 2.2 LLM API 是无状态的，历史必须由客户端原样回传

每一轮请求都要把完整历史重新发一遍。DeepSeek 在 thinking 模式下加了一条**比 OpenAI 标准更严格的规则**：

> 如果上一轮 assistant 响应里有 `reasoning_content`，下一轮请求里这条 assistant message **必须**带回 `reasoning_content`，否则服务端拒绝。

Anthropic Claude 的 thinking block 有类似（且更严格）的要求：必须原样回传带 **signature**（服务端签名）的 thinking block，且不允许伪造或修改其内容；DeepSeek 没有签名机制，只要求字段在场。这种「必须回传 reasoning」是推理模型的普遍设计。

### 2.3 `@ai-sdk/openai` 不认识这个扩展字段

`@ai-sdk/openai` adapter 严格按 OpenAI 标准协议工作：

- 反序列化响应时：只认 `role` / `content` / `tool_calls`，把 `reasoning_content` **丢弃**
- 序列化下一轮请求时：自然也带不上这个字段

→ 服务端校验失败 → 400。

### 2.4 为什么 DeepSeek 要求这么严格？

- **缓存命中**：DeepSeek 服务端的 prefix cache 需要完整还原历史（含 reasoning）才能命中
- **多轮一致性**：thinking + tool_call 是一个原子动作（"我想了想，所以决定调这个工具"），**在已开启 thinking 的前提下**，丢掉 reasoning_content 会让模型在下一轮看到"凭空决定调工具"的历史，行为退化

> 注意：这里说的是「开了 thinking 但回传时被 adapter 丢弃」的场景。如果**从一开始就关掉 thinking**（见 §3 方案 B），历史里本来就没有 reasoning，不存在丢失问题，也不会退化。

---

## 3. 解决方案

### 方案 A：换用官方 adapter `@ai-sdk/deepseek`（已采用）

```ts
import { createDeepSeek } from "@ai-sdk/deepseek";

const llm = createDeepSeek({
  baseURL: process.env.SUPER_AI_API_BASE_URL,
  apiKey: process.env.SUPER_AI_API_KEY,
});
const model = llm("deepseek-v4-flash");
```

DeepSeek 官方 adapter 知道 `reasoning_content` 字段，会正确存进 message 的 reasoning block 并在下一轮序列化回去。**这是协议层的根治**。

### 方案 B：在 streamText 里关闭 thinking（已采用）

即使换了正确的 adapter，DeepSeek 在 **agent + 工具调用** 场景下，thinking 模式仍存在工程稳定性问题（偶发服务端 500 / 空响应 / 不返回 tool_calls）。

```ts
streamText({
  model,
  ...,
  providerOptions: {
    deepseek: { thinking: { type: "disabled" } },
  },
});
```

**两个方案是互补的，不是替代关系**：

- 方案 A 解决"协议字段丢失"（adapter 层）
- 方案 B 解决"agent 场景下服务端不稳 + 性能"（业务层）

### 已废弃方案：fetch 拦截注入 thinking flag

最早的临时方案是 hack `createOpenAI` 的 `fetch` 钩子，在 body 里注入 `thinking: { type: "disabled" }`。能跑但有几个问题：

- 侵入性强、性能开销（每请求 JSON.parse + stringify）
- 把 provider 私有约定写死在通用 adapter 里
- 错误吞掉（catch 静默失败）

换 adapter + `providerOptions` 之后，已删除该 hack。

---

## 4. 关 thinking 是否会损失模型能力？

**Agent + 工具调用场景下，损失很小**：

| 任务类型                       | thinking 提升            |
| ------------------------------ | ------------------------ |
| 数学/逻辑推理                  | 大（10-30%）             |
| 多步代码规划                   | 中（5-15%）              |
| **工具调用决策（agent loop）** | **小到无，有时反而更差** |
| 简单对话、抽取、改写           | 几乎无                   |

agent loop 的"思考"已经被外化到多步循环里——每一步看工具结果再决定下一步，本身就是 chain-of-thought 的一种形式。每步再开 thinking 收益边际很低，但要付：

- **延迟**：thinking 占输出 token 30-70%，整任务延迟可能 2-3 倍
- **成本**：reasoning_content 也算 output token 计费
- **流式体验**：thinking 阶段无输出，看起来"卡住"

### 主流 agent 工具的实际选择

| 工具                | 默认是否开 thinking                                                                     |
| ------------------- | --------------------------------------------------------------------------------------- |
| Claude Code         | 开（Anthropic 自家，原生支持，无兼容问题）                                              |
| Cursor Agent        | 由模型决定：选 reasoning 模型（Claude thinking / o-series）默认开，普通 chat 模型不开   |
| Cline               | 默认关，需用户在设置里显式开启                                                          |
| OpenCode            | 默认关                                                                                  |
| Aider `--architect` | 分层执行：planner 模型规划 + executor 模型实施（planner 常用 reasoning 模型，但不强制） |

### 如果想发挥推理能力 — 推荐 Planner / Executor 分层

```
[复杂任务]
  ↓
Planner LLM（开 thinking，慢但聪明）→ 生成计划
  ↓
Executor LLM（关 thinking，快）→ agent loop 执行工具
  ↓
[结果]
```

DeepSeek 官方也推荐：`deepseek-reasoner` 规划 + `deepseek-chat` 执行。

---

## 5. 多 provider 工具是怎么磨平这类差异的？

Cursor / OpenCode / Cline / Continue / Aider 等工具用的是 **4 层架构**：

### 第 1 层：Provider Adapter

每个 provider 一个 adapter，把"通用请求"翻译成各家 wire format。AI SDK 本身就是这层的开源实现。

| 维度      | OpenAI                                                     | Anthropic                              | DeepSeek                      | Gemini                 |
| --------- | ---------------------------------------------------------- | -------------------------------------- | ----------------------------- | ---------------------- |
| 消息格式  | `messages[]`                                               | `system` 单独 + `messages[]`           | OpenAI 兼容                   | `contents[]` + `parts` |
| 工具调用  | `tool_calls`                                               | `tool_use` block                       | `tool_calls`                  | `functionCall` part    |
| Reasoning | o1/o3 返回 `reasoning` summary（不可见原始 CoT），无需回传 | `thinking` block + signature，必须回传 | `reasoning_content`，必须回传 | `thought` part         |
| 缓存      | 自动                                                       | `cache_control` 显式                   | 自动 prefix                   | 显式 cachedContent     |

### 第 2 层：归一化的内部消息 IR

工具内部不直接存 OpenAI / Anthropic 格式，而是定义自己的 content block 数组：

```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }  // 一等公民
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; toolUseId: string; content: ... }
  | { type: "image"; data: string; mimeType: string };
```

**reasoning 是一等公民，不会被丢**。adapter 在序列化时按目标 provider 决定要不要带、用什么字段名。

### 第 3 层：Capability Matrix

每个模型注册能力表，业务层按能力开关功能：

```ts
{
  "deepseek-v4-flash": {
    supportsTools: true,
    supportsThinking: true,
    supportsParallelToolCalls: true,
    ...
  }
}
```

### 第 4 层：Per-provider Prompt / Tool 调优

即使协议磨平了，模型行为差异还在：Claude 偏好 XML 格式，GPT 偏好 markdown，DeepSeek 工具 schema 容错差。成熟工具会按 family 做 prompt 模板分支。

---

## 6. 多模型切换的具体实现方式

把"如何在运行时切换模型"拆成 3 个常见层次，从简单到复杂：

### 6.1 配置驱动的模型工厂（最常见）

集中一个 `createModel(spec)` 工厂，按 `provider:model` 字符串分发：

```ts
// src/model-factory.ts
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export interface ModelSpec {
  provider: "openai" | "deepseek" | "anthropic";
  model: string;
  baseURL?: string;
  apiKey?: string;
}

export function createModel(spec: ModelSpec): LanguageModel {
  switch (spec.provider) {
    case "openai":
      return createOpenAI({ baseURL: spec.baseURL, apiKey: spec.apiKey })(
        spec.model,
      );
    case "deepseek":
      return createDeepSeek({ baseURL: spec.baseURL, apiKey: spec.apiKey })(
        spec.model,
      );
    case "anthropic":
      return createAnthropic({ apiKey: spec.apiKey })(spec.model);
  }
}
```

调用方只关心 spec：

```ts
// 通过环境变量 / CLI flag / 配置文件传入
const model = createModel({
  provider: process.env.LLM_PROVIDER as any,
  model: process.env.LLM_MODEL!,
  apiKey: process.env.LLM_API_KEY,
});
```

**OpenCode、Continue、Aider 都是这个模式**——区别只是配置来源（yaml / json / env）。

### 6.2 加 Capability Matrix，让业务按能力开关

只有工厂还不够。不同模型支持的特性不同（thinking、parallel tool calls、vision、cache 等），业务层需要按能力分支：

```ts
// src/model-registry.ts
export interface ModelCapabilities {
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsParallelToolCalls: boolean;
}

export const MODEL_REGISTRY: Record<string, ModelCapabilities> = {
  "deepseek:deepseek-v4-flash": {
    contextWindow: 128_000,
    maxOutput: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsThinking: true,
    supportsParallelToolCalls: true,
  },
  "anthropic:claude-opus-4.7": {
    contextWindow: 200_000,
    maxOutput: 32_000,
    supportsTools: true,
    supportsVision: true,
    supportsThinking: true,
    supportsParallelToolCalls: true,
  },
  // ...
};
```

业务层可以写：

```ts
const caps = MODEL_REGISTRY[`${spec.provider}:${spec.model}`];

streamText({
  model,
  ...
  // 仅当模型支持 thinking 时，才需要显式注入禁用指令
  providerOptions: caps.supportsThinking
    ? { [spec.provider]: { thinking: { type: "disabled" } } }
    : undefined,
});
```

OpenCode 直接复用 [models.dev](https://models.dev) 这个开源数据库；Cline 把矩阵 hardcode 在每个 ApiHandler 里。

### 6.3 引入 IR + Adapter，彻底解耦业务和协议

到了多 provider 数量超过 5-6 个、还要做 prompt cache 优化时，AI SDK 的 `ModelMessage` 抽象会不够用，团队会自定义内部 IR：

```
[业务层]
  使用统一 ContentBlock IR 操作消息
       ↓
[Adapter 层]
  按目标 provider 把 IR 序列化成 wire format
  按响应 wire format 反序列化回 IR（保留所有扩展字段）
       ↓
[各家 SDK / HTTP]
```

这一层是 Cline、Continue 自己做了，OpenCode 暂时还在 AI SDK 之上薄薄加了一层。一般小项目**不需要**到这一步。

### 6.4 不同切换模式

| 模式       | 何时切换                            | 例子                                                           |
| ---------- | ----------------------------------- | -------------------------------------------------------------- |
| 启动时切换 | 进程启动读 env / config             | 多数 CLI 工具                                                  |
| 会话级切换 | 用户在 UI / `/model gpt-5` 命令切换 | Cursor、Cline、Aider                                           |
| 任务级切换 | 一次任务里多个模型协作              | Aider architect（reasoner 规划 + chat 执行）、planner-executor |
| 步级路由   | 每一步根据复杂度选模型              | Cursor 的"Auto"模式、Continue 的 model router                  |

### 6.5 落到本项目的最小迁移路径

如果你想把当前项目升级成多 provider，按这个顺序最省事：

1. **抽 `createModel` 工厂**（5 分钟）：把 `index.ts` 里的硬编码挪到 `src/model-factory.ts`，按 env 分发。
2. **加 Capability Matrix**（10 分钟）：把"是否要关 thinking"从 hardcode 改成查表。这样未来加 GPT / Claude 时不需要改 `agent-loop.ts`。
3. **支持 `/model` 命令**（可选）：在 readline 输入里识别 `/model deepseek:v4-pro`，运行时切换 `model` 变量。
4. **任务级分层**（可选）：复杂任务先调一次 reasoner planner，再交给 executor agent loop。

前 2 步是最高 ROI 的，建议先做。

---

## 7. 关键经验

1. **"OpenAI 兼容"不等于"完全兼容"**。DeepSeek、Together、Groq、Ollama 等几乎都有自己的扩展字段或额外要求。生产环境用错 adapter 是常见踩坑点。
2. **无状态协议下，客户端的 message round-trip 完整性是一等公民问题**。响应里出现的字段，如果服务端要求下一轮原样回来，客户端必须能完整保留。
3. **协议扩展字段一旦被设计成"必传"，就和"可选"完全不是一回事**。OpenAI o1/o3 只返回 `reasoning` summary 且无需回传；DeepSeek 的 `reasoning_content` 是"必传"，就要求所有客户端必须升级 adapter。
4. **推理模型的 thinking block 都有回传约束**——不只是 DeepSeek。Claude thinking、Gemini thoughts、OpenAI o1 reasoning summary 都类似。
5. **agent + 工具调用场景下，thinking 的边际收益本来就低**。主流工具默认都是关的，要发挥推理能力请用分层架构。
6. **修问题分清"协议层"和"业务层"**：换 adapter 治协议，关 thinking 治业务稳定性，两件事独立。

---

## 8. 当前项目状态

- ✅ Provider 已切换到 `@ai-sdk/deepseek`（[src/index.ts](../src/index.ts)）
- ✅ `streamText` 调用中通过 `providerOptions.deepseek.thinking = { type: "disabled" }` 关闭 thinking（[src/agent-loop.ts](../src/agent-loop.ts)）
- ✅ 删除了原先的 fetch 拦截 hack
- 🔜 后续如需更强推理能力，可考虑加入 Planner / Executor 分层（一次性 plan + agent loop 执行）
