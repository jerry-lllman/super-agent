import { ToolDefinition } from "./tool-registry";
import TurndownService from "turndown";

// 自动挡
export const tavilySearchTool: ToolDefinition = {
  name: "web_search",
  description: "搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      max_results: {
        type: "number",
        description: "返回的最大结果数量，默认为5",
      },
    },
    required: ["query"],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return "[web_search] 错误：TAVILY_API_KEY 未设置";

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results,
        include_answer: true,
      }),
    });

    if (!res.ok) return `[web_search] 错误：API请求失败，状态码 ${res.status}`;

    const data = await res.json();
    const lines: string[] = [];

    if (data.answer) {
      lines.push(`## AI 摘要\n${data.answer}\n`);
    }

    for (const result of data.results || []) {
      lines.push(`### ${result.title}`);
      lines.push(result.url);
      lines.push(result.content || result.snippet || "");
      lines.push(""); // 空行分隔
    }

    return lines.join("\n") || "[web_search] 没有找到相关结果";
  },
};

// 手动挡
export const serperSearchTool: ToolDefinition = {
  name: "serper_search",
  description:
    "搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和内容摘要",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      max_results: {
        type: "number",
        description: "返回的最大结果数量，默认为5",
      },
    },
    required: ["query"],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return "[serper_search] 错误：SERPER_API_KEY 未设置";

    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ q: query, num: max_results }),
    });

    if (!res.ok)
      return `[serper_search] 错误：API请求失败，状态码 ${res.status}`;

    const data = await res.json();
    const lines: string[] = [];

    // Knowledge Graph
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      lines.push(`## ${kg.title}`);
      if (kg.description) lines.push(kg.description);
      lines.push("");
    }

    for (const result of (data.organic || []).slice(0, max_results)) {
      lines.push(`### ${result.title}`);
      lines.push(result.link);
      lines.push(result.snippet || "");
      lines.push(""); // 空行分隔
    }

    return lines.join("\n") || "[serper_search] 没有找到相关结果";
  },
};

// Web Fetch (手动挡配套)
//
// 【与 Claude Code 的差异】
// Claude Code 的 WebFetch = 抓取 HTML → 转 Markdown → 用小模型对内容执行 prompt → 返回"答案"
//   例: WebFetch({ url: "...", prompt: "有哪些新特性？" }) → "React 19 引入了 Server Components..."
//   本质是一个微型 RAG 管道，内置小模型做阅读理解。
//
// 我们的 web_fetch = 抓取 HTML → 转 Markdown → 直接返回全文
//   例: web_fetch({ url: "..." }) → "# React Blog\n\n## 2024-06-15\n\nReact 19..."
//   本质是 HTTP 客户端 + HTML→Markdown 转换器，阅读理解完全交给主 LLM。
//
// 另外本项目还有一个 fetch_url（tools.ts），输出纯文本（regex 剥标签），
// 与本工具的差异仅在于输出格式（Markdown vs 纯文本），而非能力层级。
export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "抓取指定 URL 的网页内容，转换为 Markdown 格式。搭配 web_search 使用——先搜索拿到链接，再用这个工具读取详细内容",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的网页 URL" },
    },
    required: ["url"],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SuperAgent/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) return `抓取失败：状态码 ${res.status}`;

      const html = await res.text();
      return htmlToMarkdown(html);
    } catch (e: any) {
      return `抓取失败：${e.message}`;
    }
  },
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

turndown.remove(["script", "style", "nav", "footer", "header", "iframe"]);

const htmlToMarkdown = (html: string): string => turndown.turndown(html);

// 根据环境变量
export function pickSearchTool(): ToolDefinition {
  if (process.env.TAVILY_API_KEY) return tavilySearchTool;
  if (process.env.SERPER_API_KEY) return serperSearchTool;
  return tavilySearchTool;
}
