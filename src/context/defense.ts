import { ModelMessage } from "ai";
import { toolResultOutputToText } from "./tool-result-output";

// ———— Layer 1: Token Estimation ————
export class TokenTracker {
  private lastPreciseCount = 0;
  private pendingChars = 0;

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;
  }

  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  get estimatedTokens(): number {
    return Math.max(
      0,
      this.lastPreciseCount + Math.ceil(this.pendingChars / 4),
    );
  }

  get status(): { tokens: number; percent: number; needsAction: boolean } {
    const tokens = this.estimatedTokens;
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100);

    return {
      tokens,
      percent,
      needsAction: percent >= 75,
    };
  }
}

const CONTEXT_WINDOW = 200_000;

function countMessageChars(message: ModelMessage): number {
  let chars = 0;
  if (typeof message.content === "string") {
    return message.content.length;
  }
  if (!Array.isArray(message.content)) return chars;

  for (const part of message.content) {
    if ("text" in part && typeof part.text === "string") {
      chars += part.text.length;
    } else if ("output" in part) {
      chars += toolResultOutputToText(part.output).length;
    } else if ("input" in part) {
      chars += JSON.stringify(part.input).length ?? 0;
    }
  }
  return chars;
}

function countMessagesChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += countMessageChars(message);
  }
  return chars;
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);

  // 4 个字符约等于 1 个 token，1 个汉字约 1.5-2 个 token，估算是按照 1.2 倍计算
  return Math.ceil((chars / 4) * 1.2);
}

// ———— Layer 2: Dynamic Tool Result Truncation ————
interface TruncationConfig {
  maxSingleResult: number;
  contextBudgetChars: number;
}

const DEFAULT_TRUNCATION: TruncationConfig = {
  maxSingleResult: Math.floor(CONTEXT_WINDOW * 0.5 * 2), // 50% of window, 2 chars/token
  contextBudgetChars: Math.floor(CONTEXT_WINDOW * 0.75 * 4), //  75% of window, 4 chars/token
};
