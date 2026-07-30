import type { ModelMessage } from "ai";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_DIR = ".sessions";

export interface SessionEntry {
  type: "message";
  timestamp: string;
  message: ModelMessage;
}

export class SessionStore {
  private dir: string;
  private sessionId: string;

  // 初始化会话存储目录，并为当前对话选择一个 jsonl 文件名。
  constructor(sessionId: string = "default") {
    this.sessionId = sessionId;
    this.dir = SESSION_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  // 统一生成当前会话的落盘路径，避免调用方重复拼接文件名。
  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  // 追加单条模型消息到 jsonl 文件，每行独立存储便于增量写入和恢复。
  append(message: ModelMessage): void {
    const entry: SessionEntry = {
      type: "message",
      timestamp: new Date().toISOString(),
      message,
    };

    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  // 批量追加消息，复用 append 保持每条记录的时间戳和格式一致。
  appendAll(messages: ModelMessage[]): void {
    for (const msg of messages) {
      this.append(msg);
    }
  }

  // 从 jsonl 文件恢复消息历史；遇到损坏行时跳过，尽量保留可用上下文。
  load(): ModelMessage[] {
    if (!existsSync(this.filePath)) return [];

    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];

    const messages: ModelMessage[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === "message") {
          messages.push(entry.message);
        }
      } catch {
        /** skip malformed lines */
      }
    }
    return messages;
  }

  // 检查当前会话文件是否已经存在，用于决定是恢复还是新建会话。
  exists(): boolean {
    return existsSync(this.filePath);
  }
}
