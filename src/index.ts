import "dotenv/config";
import { type ModelMessage } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { ToolRegistry } from "./tool-registry";
import { allTools } from "./tools";
import { agentLoop } from "./agent-loop";

const llm = createDeepSeek({
  baseURL: process.env.OPENAI_API_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_API_KEY
  ? llm("deepseek-v4-flash")
  : createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? "并发安全" : "非并发安全",
    tool.isReadOnly ? "只读" : "可写",
  ].join(", ");
  console.log(`- ${tool.name}: ${tool.description} [${flags}]`);
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const systemPrompt = `你是 Super Agent，一个能读代码、抓网页、生成项目的 AI 助手。
你有这些工具可用：read_file, write_file, list_directory, edit_file, glob, grep, bash, fetch_url, start_preview, get_weather, calculator。

针对常见任务的执行策略：

1. 用户让你"分析项目"或"找代码"时：
  先 list_directory 看结构 → grep 定位关键内容 → 必要时 read_file 看细节 → 最后给出归纳总结。

2. 用户给你 URL 时：
  用 fetch_url 抓取（多 URL 可以并行），再综合总结。

3. 用户让你"做一个网页应用 / 待办应用 / 任意 web demo"时（必须实际调用工具，不要只描述）：

   **重要的项目约定（不要自己重写 bootstrap）**：
  - app/index.html 已经预置在模板里，固定用 import maps 引 React + Babel Standalone 实时编译 TSX
  - app/index.html 固定加载 ./App.tsx 作为入口、固定引用 ./styles.css 作为样式
  - 你**禁止**写入或修改 app/index.html（它已经能正确工作）
  - 按照 skills/frontend-design.md 中的设计规范进行设计

   **你需要做的事**：
  - 用 write_file 至少生成这三个文件：
    1. app/styles.css — 应用样式
     2. app/App.tsx — **必须**用 \`import { createRoot } from 'react-dom/client'\` 把组件渲染到 \`document.getElementById('root')\`
    3. app/Button.tsx 或其他组件 .tsx — 可被 App.tsx import
  - .tsx 之间用相对路径 import：\`import { Button } from './Button.tsx'\`（必须带 .tsx 后缀）
  - React 用 \`import React, { useState } from 'react'\`，不要从其他源导入
  - 文件全部写完后**立即**调用 start_preview 启动预览服务器（这一步绝对不能省）
  - 最后用一段简短文本告诉用户：生成了哪些文件 + 预览地址

  4. 用户让你搜索或查询时：
  你有 web_search 和 web_fetch 两个搜索相关的工具：
  - web_search：搜索互联网，返回相关网页的标题、链接和内容摘要
  - web_fetch：抓取指定 URL 的完整内容，转为 Markdown

  当用户问的问题需要最新信息时，先用 web_search 搜索，拿到结果后总结回答。
  如果搜索结果的摘要不够详细，用 web_fetch 抓取具体链接的全文。

回答简洁直接，独立的工具调用尽量并行执行。引用信息时标注来源链接`;

`你是 Super Agent，一个能搜索互联网、读写代码的 AI 助手。

`;

const messages: ModelMessage[] = [];

function ask() {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    await agentLoop(model, registry, messages, systemPrompt);

    ask();
  });
}

console.log('\nSuper Agent v0.4.3 — Mini Apps（"exit" 退出）');
console.log("试试：");
console.log("  1. 找出项目里所有 TODO");
console.log(
  "  2. 去 https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling 看下文档总结",
);
console.log("  3. 做一个待办清单的网页应用\n");
console.log("  4. 搜索一下 Vercel AI SDK 最新版本");
console.log("  5. 2026 年最流行的 Agent 框架是什么");
console.log("  6. 帮我查一下 TypeScript 5.8 有什么新特性\n");
ask();
