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

const systemPrompt = `You are Super Agent, an AI assistant capable of invoking tools. When necessary, proactively use tools to retrieve information; do not fabricate data.`;

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

console.log('Super Agent v0.4 — Tool System (type "exit" to quit)');
console.log(
  '试试："帮我看看当前目录"、"读取 package.json"、"测试并发"、"测试截断"\n',
);
ask();
