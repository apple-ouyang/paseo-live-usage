export function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

/** Keeps the pill label from ever widening: 4 digits max, k above 1000. */
export function fmtTps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
}

export function fmtHit(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value >= 99.95 ? "99.9" : value.toFixed(value >= 10 ? 0 : 1);
}

export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function fmtAge(value: number): string {
  if (value < 3_000) return "刚刚";
  if (value < 60_000) return `${Math.round(value / 1000)} 秒前`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟前`;
  return `${(value / 3_600_000).toFixed(1)} 小时前`;
}

/** Local HH:MM for "when did that call land". */
export function fmtClock(at: number | null | undefined): string {
  if (at === null || at === undefined || !Number.isFinite(at)) return "--:--";
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function fmtCost(value: number, currency: "USD" | "CNY"): string {
  const symbol = currency === "CNY" ? "¥" : "$";
  if (value < 0.01) return `${symbol}${value.toFixed(4)}`;
  if (value < 1) return `${symbol}${value.toFixed(3)}`;
  return `${symbol}${value.toFixed(2)}`;
}

export const SOURCE_LABELS: Record<string, string> = {
  "dsh-log": "dsh 会话日志",
  "pi-session": "pi 会话文件",
  "claude-session": "Claude 会话文件",
  "codex-session": "Codex 会话文件",
  "devin-db": "Devin CLI 会话",
  "paseo-usage": "Paseo lastUsage",
};

/** Row-2 style duration: 4.7s / 25s / 1m30s. */
export function fmtSec(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Row-3 style duration: 45s / 3.2m / 78m / 1.3h. */
export function fmtMin(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const minutes = value / 60_000;
  if (minutes < 10) return `${minutes.toFixed(1)}m`;
  if (minutes < 1000) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * Breakdown durations. Same scale as `fmtMin` but keeps one decimal below ten
 * seconds, so a 0.4s thinking span reads as "0.4s" instead of rounding to "0s".
 */
export function fmtDur(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  return fmtMin(value);
}
