import type { LiveUsageResult } from "../shared/rpc.ts";

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

/**
 * Durations in the pill: one decimal below ten seconds, whole seconds above.
 * Same shape as `fmtSec` but never wider than `14s`.
 */
export function fmtTtft(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

/**
 * Label inside the composer pill: newest measured numbers only, one line.
 *
 *   `140 t/s · 首字 5.3s`
 *
 * The speed is the newest measured rate, in this order:
 *   - dsh reports the open turn (`turnSpeed`);
 *   - pi reports the last sampled call (`speed.latest`), whose denominator is the
 *     decode window — the session file's per-request wall clock includes the
 *     first-token wait and would show 7 t/s for a call that decoded at 140;
 *   - a call whose decode window was too short to measure (`< MIN_SAMPLE_MS`)
 *     falls through to the session-wide decode rate, not to the wall clock;
 *   - providers without any decode split have one wall clock per call (`last`).
 * Cache hit rate is deliberately NOT in the label (用户口径 2026-11-12): it keeps
 * losing the tail to Paseo's truncation in narrow panes, and the popover shows it.
 * Totals live there too, so the pill never grows a second line.
 */
export function pillLabel(data: LiveUsageResult | undefined): string {
  if (!data) return "…";
  if (!data.supported) return "–";
  const parts: string[] = [];
  // Only measured rates ever reach the label.
  const tps =
    data.turnSpeed?.tokensPerSecond ??
    data.speed?.latest?.tokensPerSecond ??
    data.speed?.tokensPerSecond ??
    data.last?.tokensPerSecond ??
    null;
  if (tps !== null && tps > 0) parts.push(`${fmtTps(tps)} t/s`);
  const ttft = data.speed?.latest?.ttftMs ?? null;
  if (ttft !== null && Number.isFinite(ttft) && ttft > 0) parts.push(`首字 ${fmtTtft(ttft)}`);
  if (parts.length === 0 && data.context) {
    parts.push(`${Math.round((data.context.used / data.context.window) * 100)}% ctx`);
  }
  return parts.length > 0 ? parts.join(" · ") : "–";
}

export function fmtHit(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  // Never round up to a "100%" that was not measured: 99.8 keeps its decimal.
  if (value >= 99.95) return "99.9";
  if (value >= 99) return value.toFixed(1);
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
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
  "grok-session": "Grok 会话文件",
  "devin-db": "Devin CLI 会话",
  "droid-session": "droid 会话文件",
  "agy-db": "Antigravity 会话库",
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
