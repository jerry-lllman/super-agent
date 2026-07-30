import { createHash } from "node:crypto";

// --- 类型定义 ---

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

export type DetectorKind =
  | "generic_repeat"
  | "ping_pong"
  | "global_circuit_breaker";

export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: DetectorKind;
      count: number;
      message: string;
    };

// --- 配置 ---

const HISTORY_SIZE = 30; // 滑动窗口大小
const WARNING_THRESHOLD = 5; // 警告阈值（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8; // 严重阈值（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10; // 熔断阈值（演示用，生产环境通常是 30）

// --- 指纹计算 ---

// 用稳定的 key 顺序序列化任意参数，确保对象字段顺序不同也能得到同一指纹。
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
}

// 生成短哈希用于日志和窗口统计，避免在历史记录里保存完整参数或结果。
function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// 将工具名和参数一起纳入指纹，区分“同参数调用不同工具”的情况。
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

// 为工具结果生成指纹，用来判断多次调用是否真的产生了新信息。
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

// --- 滑动窗口 ---

const history: ToolCallRecord[] = [];

// 记录一次工具调用，并维护固定长度滑动窗口，防止历史无限增长。
export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift();
}

// 把工具执行结果补写回最近一次匹配的调用记录，供“无进展”检测使用。
export function recordResult(
  toolName: string,
  params: unknown,
  result: unknown,
): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].toolName === toolName &&
      history[i].argsHash === argsHash &&
      !history[i].resultHash
    ) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

// 每次新的 agentLoop 开始前清空检测窗口，避免不同用户问题之间互相影响。
export function resetHistory(): void {
  history.length = 0;
}

// --- 检测器 ---

// 统计同一工具同一参数连续返回相同结果的次数，衡量是否“没有进展”。
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    if (!r.resultHash) continue;
    if (!lastResultHash) {
      lastResultHash = r.resultHash;
      streak = 1;
      continue;
    }
    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

// 检测最近调用是否在两个参数指纹之间来回切换，识别典型乒乓循环。
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0;

  const last = history[history.length - 1];
  let otherHash: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash;
      break;
    }
  }
  if (!otherHash) return 0;

  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }

  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

// --- 主检测函数 ---

// 综合无进展、乒乓和普通重复三个检测器，返回是否需要提醒或熔断。
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(toolName, argsHash);

  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    };
  }

  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "ping_pong",
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
    };
  }

  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === argsHash,
  ).length;

  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
    };
  }

  return { stuck: false };
}
