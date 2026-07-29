import "dotenv/config";
import { type ModelMessage } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { ToolDefinition, ToolRegistry } from "./tools/tool-registry";
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

const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query);
    if (results.length === 0) {
      return `没有找到匹配 "${query}" 的工具`;
    }
    return results.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};

registry.register(toolSearchTool)

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

  const deferredSummary = registry.getDeferredToolSummary()

  console.log(`\n deferredSummary: ${deferredSummary} \n`)

  const systemPrompt = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。
如果你需要的工具不在当前列表中，使用 tool_search 工具搜索可用工具。
回答要简洁直接。${deferredSummary}`;


  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });


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
