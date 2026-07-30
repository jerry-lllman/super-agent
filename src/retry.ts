// 根据错误消息中的状态码或网络特征判断是否值得重试。
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || "";
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    if ([429, 529, 408].includes(status)) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (message.includes("ECONNRESET") || message.includes("EPIPE")) return true;
  if (message.includes("ETIMEDOUT") || message.includes("timeout")) return true;
  if (message.includes("fetch failed") || message.includes("network"))
    return true;
  if (message.includes("No output generated")) return true;
  return false;
}

// 计算带抖动的指数退避时间，减少多个请求同时重试造成的尖峰。
export function calculateDelay(
  attempt: number,
  baseMs = 500,
  maxMs = 30000,
): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * 0.25;
  return Math.max(0, Math.round(capped + (Math.random() * 2 - 1) * jitter));
}

// Promise 形式的延时工具，用于在重试前暂停当前异步流程。
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
