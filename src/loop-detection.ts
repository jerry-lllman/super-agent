import { createHash } from "node:crypto";

/**
 * @description 工具调用记录，用于追踪和分析工具的使用情况
 * @example
 * const record: ToolCallRecord = {
 *   toolName: 'search_files',
 *   argsHash: 'a1b2c3d4e5f6g7h8',
 *   resultHash: 'x9y8z7w6v5u4t3s2',
 *   timestamp: 1704067200000
 * }
 */
export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

/**
 * @description 循环检测器的类型，用于标识检测到的循环的具体类别
 * @example
 * // generic_repeat - 通用重复：相同工具相同参数重复调用
 * // ping_pong - 乒乓循环：两个工具调用交替进行
 * // global_circuit_breaker - 全局熔断：达到最大阈值强制停止
 */
export type DetectorKind =
  | "generic_repeat"
  | "ping_pong"
  | "global_circuit_breaker";

/**
 * @description 循环检测的结果，指示是否检测到循环及其严重程度
 * @example
 * // 未检测到循环
 * const result1: DetectionResult = { stuck: false }
 *
 * // 检测到警告级别的乒乓循环
 * const result2: DetectionResult = {
 *   stuck: true,
 *   level: "warning",
 *   detector: "ping_pong",
 *   count: 5,
 *   message: "[警告] 检测到乒乓循环（5 次交替），建议换个思路"
 * }
 */
export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: DetectorKind;
      count: number;
      message: string;
    };

const HISTORY_SIZE = 30;
const WARNING_THRESHOLD = 5;
const CRITICAL_THRESHOLD = 8;
const BREAKER_THRESHOLD = 10;

/**
 * @description 将任意值转换为稳定的字符串形式，用于哈希计算。确保相同的对象产生相同的字符串
 * @param value - 待转换的值
 * @returns 稳定的JSON字符串
 * @example
 * stableStringify({ b: 2, a: 1 }) // "{a:1,b:2}"
 * stableStringify([1, 2, 3]) // "[1,2,3]"
 * stableStringify('test') // "\"test\""
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
}

/**
 * @description 将输入字符串转换为SHA256哈希值的前16个字符，用于生成紧凑的哈希标识
 * @param input - 待哈希的字符串
 * @returns 哈希值（16个字符）
 * @example
 * hash('test_input') // 'a1b2c3d4e5f6g7h8'
 * hash('tool_call') // 'x9y8z7w6v5u4t3s2'
 */
function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * @description 对工具调用进行哈希处理，生成唯一的哈希标识
 * @param toolName - 工具名称
 * @param params - 工具参数对象
 * @returns 格式为 "toolName:hash" 的字符串
 * @example
 * hashToolCall('search_files', { query: 'test', maxResults: 10 })
 * // 'search_files:a1b2c3d4e5f6g7h8'
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

/**
 * @description 对工具调用的结果进行哈希处理
 * @param result - 工具执行返回的结果
 * @returns 结果的哈希值（16个字符）
 * @example
 * hashResult({ success: true, data: [...] })
 * // 'x9y8z7w6v5u4t3s2'
 * hashResult(null)
 * // 'a1b2c3d4e5f6g7h8'
 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

const history: ToolCallRecord[] = [];

/**
 * @description 记录一次工具调用，添加到历史记录中。当历史记录超过限制时自动移除最旧的记录
 * @param toolName - 工具名称
 * @param params - 工具调用的参数
 * @example
 * recordCall('read_file', { path: '/src/index.ts', startLine: 1, endLine: 50 })
 * // 工具调用被添加到历史记录
 */
export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift();
}

/**
 * @description 记录工具调用的结果，关联到之前的工具调用记录中
 * @param toolName - 工具名称
 * @param params - 工具调用的参数
 * @param result - 工具执行返回的结果
 * @example
 * recordCall('search_files', { query: 'test' })
 * const files = await search({ query: 'test' })
 * recordResult('search_files', { query: 'test' }, files)
 * // 结果被关联到对应的工具调用记录
 */
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

/**
 * @description 清空所有的工具调用历史记录，重置检测器状态
 * @example
 * // 处理完一个任务后重置历史
 * resetHistory()
 * // 历史记录被完全清空，检测器返回初始状态
 */
export function resetHistory(): void {
  history.length = 0;
}

/**
 * @description 计算特定工具调用的无进展连续次数（相同参数、相同结果的重复调用次数）
 * @param toolName - 工具名称
 * @param argsHash - 工具参数的哈希值
 * @returns 无进展的连续调用次数
 * @example
 * // 连续3次调用 search_files 相同参数且返回相同结果
 * getNoProgressStreak('search_files', 'abc123') // 3
 */
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

/**
 * @description 计算乒乓循环的次数（两个不同工具调用交替进行的次数）
 * @param currentHash - 当前工具调用的哈希值
 * @returns 乒乓循环的计数
 * @example
 * // 历史记录: tool_a -> tool_b -> tool_a -> tool_b
 * // 如果当前是 tool_a，则返回 4
 * getPingPongCount('hash_of_tool_a') // 4
 */
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

/**
 * @description 检测工具调用是否陷入循环，支持三种循环检测模式。根据严重程度返回不同的检测结果
 * @param toolName - 工具名称
 * @param params - 工具调用的参数
 * @returns 检测结果，包含是否循环、循环类型、严重程度等信息
 * @example
 * // 正常情况
 * detect('read_file', { path: 'test.ts' })
 * // { stuck: false }
 *
 * // 检测到乒乓循环警告
 * detect('tool_a', { query: 'search' })
 * // {
 * //   stuck: true,
 * //   level: 'warning',
 * //   detector: 'ping_pong',
 * //   count: 5,
 * //   message: '[警告] 检测到乒乓循环（5 次交替），建议换个思路'
 * // }
 *
 * // 检测到重复调用熔断
 * detect('read_file', { path: 'same.ts' })
 * // {
 * //   stuck: true,
 * //   level: 'critical',
 * //   detector: 'generic_repeat',
 * //   count: 8,
 * //   message: '[熔断] read_file 相同参数已调用 8 次，强制停止'
 * // }
 */
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
