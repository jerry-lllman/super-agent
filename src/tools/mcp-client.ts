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

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    this.serverName =
      args[args.length - 1]?.replace(/^@.*\//, "") || "mcp-server";
  }

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
  }
}
