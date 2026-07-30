import { jsonSchema } from "ai";
import { MCPClient, MockMCPClient } from "./mcp-client";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  shouldDefer?: boolean;
  searchHint?: string; // 搜索提示词，帮助 ToolSearch 匹配
  execute: (input: any) => Promise<unknown>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private mcpClients: Array<MCPClient | MockMCPClient> = [];

  private exclusiveLock = false;
  private concurrentCount = 0;
  private waitQueue: Array<() => void> = [];

  private discoveredTools = new Set<string>()

  // 批量注册工具定义；同名工具会被后注册的定义覆盖。
  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  // 连接一个 MCP 服务器，把远端工具转换成本项目统一的 ToolDefinition 并注册。
  async registerMCPServer(
    serverName: string,
    client: MCPClient | MockMCPClient,
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      const prefixName = `mcp__${serverName}__${tool.name}`;

      if (this.tools.has(prefixName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixName,
        description: `[MCP ${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (input: any) => toolClient.callTool(originalName, input)
      });

      registered.push(prefixName);
    }

    return registered;
  }

  // 关闭所有已连接的 MCP 客户端，通常用于进程退出前清理资源。
  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }

  // 按名称获取单个工具定义，供调试或精确调用场景使用。
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  // 返回当前注册表中的所有工具，包括尚未暴露给模型的延迟工具。
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // 返回当前应放入模型 prompt 的工具；延迟工具只有被 tool_search 发现后才会激活。
  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter(tool => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false
      }
      return true
    })
  }

  // 生成延迟工具摘要，放进系统提示中引导模型先用 tool_search 获取完整 Schema。
  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter(tool => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name)
    })

    if (deferred.length === 0) return ''

    const lines = deferred.map(t => {
      const hint = t.searchHint ? ` - ${t.searchHint}` : ''
      return `  - ${t.name}${hint}`
    })

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  // 粗略估算工具定义占用的 token，帮助观察延迟加载节省了多少 prompt 空间。
  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }).length

      const tokens = Math.ceil(schemaSize / 4)

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens
      } else {
        active += tokens
      }
    }

    return { active, deferred, total: active + deferred }
  }

  // 获取共享锁：并发安全工具可同时运行，但必须等待独占工具完成。
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  // 释放共享锁；最后一个并发工具完成时唤醒等待队列。
  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：写类或非并发安全工具必须等所有共享工具结束后单独执行。
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  // 释放独占锁并唤醒等待中的共享或独占工具。
  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 一次性放行当前等待队列；每个等待者会重新检查锁条件。
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  // 把内部工具定义转换成 AI SDK 需要的 tools 格式，并在执行时套上锁和结果截断。
  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};

    const activeTools = this.getActiveTools()

    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        // 模型实际触发工具时会进入这里，先按并发策略加锁再调用原始 execute。
        execute: async (input: any) => {
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${tool.name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${tool.name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }

  // 根据 tool_search 查询激活延迟工具；当前实现只接受精确名称或逗号分隔名称。
  searchTools(query: string): ToolDefinition[] {
    const q = query.trim()
    const results: ToolDefinition[] = []

    const names = q.includes(',')
      ? q.split(',').map(n => n.trim()).filter(Boolean)
      : [q]

    for (const name of names) {
      console.log(`[search_tool: tool_name]: ${name}`)
      const tool = this.tools.get(name)

      if (tool && tool.name !== 'tool_search') {
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }

    return results
  }


}

// 对超长工具结果保留头尾内容，降低上下文占用同时保留关键信息线索。
export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
