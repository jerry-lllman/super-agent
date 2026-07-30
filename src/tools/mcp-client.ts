import { ChildProcess, spawn } from "node:child_process";
import { createInterface, Interface } from "node:readline";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class MCPClient {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private serverName: string;

  // 保存 MCP 启动命令，并从包名推导一个便于日志识别的服务器名。
  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    this.serverName =
      args[args.length - 1]?.replace(/^@.*\//, "") || "mcp-server";
  }

  // 启动 stdio MCP 子进程，建立 JSON-RPC 响应监听，并完成 initialize 握手。
  async connect(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });

    this.process.on("error", (err) => {
      console.error(` [MCP] 进程启动失败：${err.message}`);
    });

    this.process.stderr?.on("data", () => {});

    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(
              new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
            );
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {}
    });

    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "super-agent", version: "0.5.0" },
    });

    this.process.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n",
    );
  }

  // 发送一条 JSON-RPC 请求，并用 id 把异步响应匹配回对应 Promise。
  private send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 15000);

      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.process!.stdin!.write(msg + "\n");
    });
  }

  // 请求 MCP 服务器暴露的工具清单，供 ToolRegistry 动态注册。
  async listTools(): Promise<MCPTool[]> {
    const result = await this.send("tools/list", {});
    return result.tools || [];
  }

  // 调用 MCP 工具并提取 text 类型内容，统一成 Agent 可读的字符串结果。
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result: MCPCallResult = await this.send("tools/call", {
      name,
      arguments: args,
    });
    const texts = (result.content || [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    return texts.join("\n") || "(无返回内容)";
  }

  // 关闭 readline 和子进程，释放 MCP 连接相关资源。
  async close(): Promise<void> {
    if (this.rl) this.rl.close();
    if (this.process) this.process.kill();
  }
}

export class MockMCPClient {
  // Mock 客户端不需要建立真实连接，保留异步接口以兼容 MCPClient。
  async connect(): Promise<void> {}

  // 返回一组固定工具定义，用于没有凭据或无法启动子进程时演示 MCP 注册流程。
  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: "list_issues",
        description: "列出 GitHub 仓库的 issues",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "仓库所有者" },
            repo: { type: "string", description: "仓库名称" },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "get_file_contents",
        description: "获取 GitHub 仓库中文件的内容",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "仓库所有者" },
            repo: { type: "string", description: "仓库名称" },
            path: { type: "string", description: "文件路径" },
          },
          required: ["owner", "repo", "path"],
        },
      },
    ];
  }

  // 根据工具名返回模拟数据，让上层逻辑无需区分真实 MCP 和 Mock MCP。
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "list_issues":
        return JSON.stringify(
          [
            {
              number: 42,
              title: "支持 MCP 协议接入",
              state: "open",
              labels: ["enhancement"],
            },
            {
              number: 41,
              title: "循环检测阈值可配置化",
              state: "open",
              labels: ["feature"],
            },
            {
              number: 39,
              title: "Token 预算用完后的优雅降级",
              state: "closed",
              labels: ["bug"],
            },
          ],
          null,
          2,
        );
      case "search_repositories":
        return JSON.stringify(
          [
            {
              full_name: "anthropics/anthropic-sdk-python",
              stars: 2800,
              description: "Anthropic Python SDK",
            },
            {
              full_name: "vercel/ai",
              stars: 12000,
              description: "AI SDK for TypeScript",
            },
            {
              full_name: "modelcontextprotocol/servers",
              stars: 5600,
              description: "MCP Servers",
            },
          ],
          null,
          2,
        );
      case "get_file_contents":
        return `# README\n\nThis is a mock file content for ${args.owner}/${args.repo}/${args.path}`;
      default:
        return `未知工具: ${name}`;
    }
  }

  // 与真实客户端保持相同生命周期接口；Mock 没有资源需要释放。
  async close(): Promise<void> {}
}
