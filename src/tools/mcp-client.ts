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

// MCP 客户端统一接口，供 ToolRegistry 和其他模块引用。
export interface IMCPClient {
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export class MCPClient implements IMCPClient {
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

