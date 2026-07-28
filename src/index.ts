import "dotenv/config";
import { type ModelMessage } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { ToolRegistry } from "./tools/tool-registry";
import { allTools } from "./tools/tools";
import { agentLoop } from "./agent-loop";
import { MCPClient, MockMCPClient } from "./tools/mcp-client";

const llm = createDeepSeek({
  baseURL: process.env.OPENAI_API_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_API_KEY
  ? llm("deepseek-v4-flash")
  : createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    const useOfficialSDK = process.env.MCP_IMPL === "official";
    const implLabel = useOfficialSDK ? "官方 SDK" : "自定义实现";
    console.log(`\n正在连接 Github MCP 服务器 (${implLabel})...`);

    try {
      let client: MCPClient | MockMCPClient;
      if (useOfficialSDK) {
        const { MCPOfficialClient } = await import(
          "./tools/mcp-client-official"
        );
        client = new MCPOfficialClient(
          "npx",
          ["-y", "@modelcontextprotocol/server-github"],
          { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
        );
      } else {
        client = new MCPClient(
          "npx",
          ["-y", "@modelcontextprotocol/server-github"],
          { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
        );
      }

      const tools = await registry.registerMCPServer("github", client);
      console.log(`   已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (error) {
      console.log(
        `   Github MCP连接失败：${error instanceof Error ? error.message : error}`,
      );
      console.log("   降级为 Mock MCP");
    }
  }

  if (!githubToken) {
    console.log(
      "\n为配置 GITHUB_PERSONAL_ACCESS_TOKEN，无法连接 Github MCP 服务器，已降级为 Mock MCP",
    );
  }

  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer("github", mockClient);
  console.log(`   已注册 ${tools.length} 个 Mock MCP 工具`);
}

async function main() {
  await connectMCP();

  console.log(`已注册 ${registry.getAll().length} 个工具：`);
  for (const tool of registry.getAll()) {
    const isMCP = tool.name.startsWith("mcp__");
    const flags = [
      isMCP ? "MCP" : "内置",
      tool.isConcurrencySafe ? "并发安全" : "非并发安全",
      tool.isReadOnly ? "只读" : "可写",
    ].join(", ");
    console.log(`- ${tool.name}: ${tool.description} [${flags}]`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const systemPrompt = `你是 Super Agent，一个能读代码、抓网页、生成项目以及一个有工具调用能力的 AI 助手。
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

4. 你有内置工具和 MCP 工具可用。MCP 工具以 mcp__ 开头，如 mcp__github__list_issues。
需要查询 GitHub 信息时，使用 mcp__github__ 前缀的工具。
需要操作本地文件时，使用内置工具。

回答简洁直接，独立的工具调用尽量并行执行。引用信息时标注来源链接`;

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

  console.log('\nSuper Agent v0.5 — MCP (type "exit" to quit)');
  console.log("试试：");
  console.log("  1. 找出项目里所有 TODO");
  console.log(
    "  2. 去 https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling 看下文档总结",
  );
  console.log("  3. 做一个待办清单的网页应用\n");
  console.log("  4. 搜索一下 Vercel AI SDK 最新版本");
  console.log("  5. 2026 年最流行的 Agent 框架是什么");
  console.log("  6. 帮我查一下 TypeScript 5.8 有什么新特性\n");

  console.log("  7. 查看 vercel/ai 的 issues");
  console.log("  8. 搜索 MCP 相关的仓库\n");

  ask();
}

main().catch(console.error);
