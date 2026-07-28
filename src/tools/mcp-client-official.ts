/**
 * MCPOfficialClient — 使用官方 @modelcontextprotocol/sdk 的 MCP 客户端适配器
 *
 * 与 MCPClient（自定义实现）保持相同的 public API：
 *   - constructor(command, args, env)
 *   - connect()
 *   - listTools() → MCPTool[]
 *   - callTool(name, args) → string
 *   - close()
 *
 * 内部委托给官方 SDK 的 Client + StdioClientTransport。
 *
 * 启用方式：MCP_IMPL=official pnpm dev
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class MCPOfficialClient {
  private client: Client;
  private transport: StdioClientTransport;
  private serverName: string;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    // 从包名提取 server 名称（如 @modelcontextprotocol/server-github → server-github）
    this.serverName =
      args[args.length - 1]?.replace(/^@.*\//, "") || "mcp-server";

    // 官方 SDK 的 Client：负责 JSON-RPC 协议握手和请求
    this.client = new Client(
      { name: "super-agent", version: "1.0.0" },
    );

    // StdioClientTransport：管理子进程的 spawn 和 stdin/stdout 通信
    // 注意：SDK 使用 getDefaultEnvironment()（PATH, HOME, SHELL 等核心变量）
    //       再与传入的 env 合并，而非继承全部 process.env。这是安全设计
    this.transport = new StdioClientTransport({
      command,
      args,
      env,
    });
  }

  /**
   * 启动子进程并完成 MCP 协议握手（initialize + notifications/initialized）
   */
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /**
   * 发现服务器提供的工具列表
   */
  async listTools(): Promise<MCPTool[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));
  }

  /**
   * 调用指定工具，返回文本结果
   *
   * 注意：官方 SDK 的 callTool 参数用 arguments（复数），
   *       这里适配为与自定义实现一致的 args 参数名
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });

    // result.content 是 MCP 协议定义的 content 数组，
    // 每个元素可以是 text / image / resource 等类型，这里只提取 text
    const texts = ((result.content as any[]) || [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);

    return texts.join("\n") || "(无返回内容)";
  }

  /**
   * 关闭与 MCP 服务器的连接，清理子进程
   */
  async close(): Promise<void> {
    await this.client.close();
  }
}
