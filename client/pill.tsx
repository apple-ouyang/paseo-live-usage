import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ComponentType } from "react";
import { useEffect } from "react";
import { Text, View } from "react-native";
import type { LiveUsageResult, LiveUsageSupported } from "../shared/rpc.ts";
import { fmtClock, fmtCost, fmtDur, fmtHit, fmtMin, fmtSec, fmtTps } from "./format.ts";
import { useLiveUsage } from "./use-live-usage.ts";
import { useTurnClock, type LiveTurnClock } from "./use-turn-clock.ts";

/** Label shown inside the composer pill, next to the icon. */
export function pillLabel(data: LiveUsageResult | undefined, liveTps: number | null = null): string {
  if (!data) return "…";
  if (!data.supported) return "–";
  const parts: string[] = [];
  // Prefer the settled per-turn rate; the live estimate only fills the gap
  // before the first call of a turn lands.
  const tps = data.turnSpeed?.tokensPerSecond ?? liveTps ?? data.last?.tokensPerSecond ?? null;
  if (tps !== null && tps > 0) parts.push(`${fmtTps(tps)} t/s`);
  const hit = fmtHit(data.last?.hitPct ?? data.totals?.hitPct ?? null);
  if (hit !== null) parts.push(`${hit}%`);
  if (parts.length === 0 && data.context) {
    parts.push(`${Math.round((data.context.used / data.context.window) * 100)}% ctx`);
  }
  return parts.length > 0 ? parts.join(" · ") : "–";
}

function hitColor(theme: PluginTheme, hit: number | null): string {
  if (hit === null) return theme.colors.foregroundMuted;
  if (hit < 50) return theme.colors.statusDanger;
  if (hit < 90) return theme.colors.statusWarning;
  return theme.colors.foreground;
}

/**
 * Icon component for one agent's pill. Polling lives here because Paseo mounts
 * pill icons only for visible agents, which is exactly when polling is wanted.
 */
export function createPillIcon(
  getHandle: () => PluginButtonRegistration | null,
  agentId: string,
): ComponentType<PluginButtonIconProps> {
  return function LiveUsagePillIcon(props: PluginButtonIconProps) {
    const { data } = useLiveUsage(agentId);
    // Acquires the shared per-agent timeline clock while this pill is mounted.
    const clock = useTurnClock(agentId);
    useEffect(() => {
      getHandle()?.update({ label: pillLabel(data, clock.liveTps) });
    }, [data, clock.liveTps]);
    const active = data?.supported === true && data.inFlight;
    return <Icon name={active ? "Activity" : "Gauge"} size={props.size} color={props.color} />;
  };
}

function Row({
  label,
  value,
  color,
  theme,
}: {
  label: string;
  value: string;
  color?: string;
  theme: PluginTheme;
}) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: color ?? theme.colors.foreground, fontSize: 12, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

function phaseLine(
  waitMs: number | null,
  thinkMs: number,
  outMs: number,
  toolMs: number,
  format: (ms: number) => string,
): string {
  // null = the turn start event was missed and the wait was never measurable.
  const wait = waitMs === null ? "–" : format(waitMs);
  return `等待 ${wait} · 思考 ${format(thinkMs)} · 输出 ${format(outMs)} · 工具 ${format(
    toolMs,
  )}`;
}

/**
 * Mirrors the pi statusline's metric set: 行1 (context / cost / hit rate / last
 * request clock), 行2 (decode + this turn's wait/think/out/tool, live), 行3
 * (thread totals). Token buckets are computed in the daemon but not shown.
 *
 * For dsh the speed rows are dsh's OWN accounting (`dsh-tui` 的会话统计): 输出速度
 * divides output by the decode window only — the first-token wait and tool
 * execution are in neither the numerator nor the denominator.
 */
function Details({
  data,
  theme,
  clock,
}: {
  data: LiveUsageSupported;
  theme: PluginTheme;
  clock: LiveTurnClock;
}) {
  const last = data.last;
  const rows: Array<{ label: string; value: string; color?: string }> = [];

  // Prefer the live value while a turn is running; the settled file value
  // replaces it. Both use the SAME definition now, so they no longer disagree.
  const liveTps = clock.running ? clock.liveTps : null;
  const fileTps = last?.tokensPerSecond ?? null;
  const speed = data.speed;
  const cost = (() => {
    if (!data.cost) return null;
    const window_ = data.cost.peak === true ? " (峰)" : data.cost.peak === false ? " (闲)" : "";
    return `${data.cost.estimated ? "≈" : ""}${fmtCost(data.cost.value, data.cost.currency)}${window_}`;
  })();
  const hit = last && last.hitPct !== null ? `${last.hitPct.toFixed(1)}%` : null;

  // This turn goes FIRST: it is what the user is watching right now. The session
  // totals below it are the second question, not the first.
  const hasLiveTurn =
    clock.running || (clock.waitMs ?? 0) + clock.thinkMs + clock.outMs + clock.toolMs > 0;
  if (hasLiveTurn) {
    const phases = phaseLine(clock.waitMs, clock.thinkMs, clock.outMs, clock.toolMs, fmtSec);
    rows.push({
      label: "本轮",
      value: clock.liveTokens > 0 ? `${phases} · 流出 ≈${clock.liveTokens} tok` : phases,
    });
  }

  // Rates: this turn's output speed, the whole session's, and the average wait
  // for the first token. All three are speeds/latencies, none is a duration.
  // `speed === null` means the provider HAS per-token timing but no call landed
  // yet (e.g. pi with no statusline samples), so it falls back to the single-call
  // rows rather than showing nothing at all.
  if (speed != null) {
    const rates: string[] = [];
    const turnTps = liveTps ?? data.turnSpeed?.tokensPerSecond ?? null;
    if (turnTps !== null) {
      rates.push(`本轮输出 ${liveTps !== null ? "≈" : ""}${fmtTps(turnTps)} t/s`);
    }
    if (speed.tokensPerSecond != null) rates.push(`总输出 ${fmtTps(speed.tokensPerSecond)} t/s`);
    if (speed.ttftAvgMs != null) rates.push(`首字均 ${fmtSec(speed.ttftAvgMs)}`);
    if (rates.length > 0) rows.push({ label: "速度", value: rates.join(" · ") });
  } else if (liveTps !== null || fileTps !== null) {
    // Providers without per-token timing expose one call's wall clock, so the
    // only honest rate is that call's output over its step window.
    rows.push({
      label: "速度",
      value: `${liveTps !== null || data.source === "paseo-usage" ? "≈" : ""}${fmtTps(
        liveTps ?? fileTps ?? 0,
      )} t/s`,
    });
  }

  // Durations: one row, total first then the parts. Because 输出 is defined as
  // 生成 − 思考, the flat sum below is exact — no need for a 生成 grouping row.
  if (speed != null) {
    const totalMs = speed.modelMs + speed.toolMs;
    const parts: string[] = [`等待首字 ${fmtDur(speed.ttftMs)}`];
    if (speed.thinkMs !== null && speed.outMs !== null) {
      parts.push(`思考 ${fmtDur(speed.thinkMs)}`, `输出 ${fmtDur(speed.outMs)}`);
    } else {
      // No thinking capture (devin, or a log predating reasoning records): keep
      // the measured generation window whole instead of inventing a 0.
      parts.push(`生成 ${fmtDur(speed.decodeMs)}`);
    }
    parts.push(`工具 ${fmtDur(speed.toolMs)}`);
    rows.push({
      label: "耗时",
      value: `总 ${fmtDur(totalMs)} = ${parts.join(" + ")}`,
    });
  }

  // Usage row: rounds/steps only exist where the store counts them.
  const usage: string[] = [];
  if (speed != null && speed.turns > 0) usage.push(`${speed.turns}轮${speed.steps}步`);
  if (hit !== null) usage.push(`命中 ${hit}`);
  if (cost !== null) usage.push(cost);
  if (last) usage.push(`结束 ${fmtClock(last.endedAt)}`);
  if (usage.length > 0) {
    rows.push({ label: "用量", value: usage.join(" · "), color: hitColor(theme, last?.hitPct ?? null) });
  }

  const timing = data.timing;
  // Only reached when there is no measured split to show: `speed` undefined means
  // the store has no per-token timing at all, and `null` means it has it but no
  // call has landed yet. Either way the ratio-split of `requestMs` is the only
  // breakdown available.
  if (speed == null && timing && timing.totalMs > 0) {
    // The files only record request vs tool walls; split the request the same way
    // the statusline does. The ratios come from the turns this client observed
    // and from the token ratio. A single in-flight turn is never a valid source:
    // mid-think it measures 100% "think" / 0% "output" and paints the whole
    // thread wrong.
    const hist = clock.history;
    const histTotal = hist.waitMs + hist.thinkMs + hist.outMs;
    let waitShare = 0.5;
    if (histTotal > 0 && hist.waitMs > 0) waitShare = hist.waitMs / histTotal;
    let thinkShare = 0;
    if (hist.thinkMs + hist.outMs > 0) thinkShare = hist.thinkMs / (hist.thinkMs + hist.outMs);
    else if (data.totals?.reasoning !== undefined && data.totals.output > 0) {
      thinkShare = Math.min(1, data.totals.reasoning / data.totals.output);
    } else if (last && last.output > 0) {
      thinkShare = Math.min(1, last.reasoning / last.output);
    }
    const wait = timing.requestMs * waitShare;
    const think = timing.requestMs * (1 - waitShare) * thinkShare;
    const out = timing.requestMs * (1 - waitShare) * (1 - thinkShare);
    const otherShare = timing.otherMs / timing.totalMs;
    rows.push({
      label: "累计",
      value: `总时 ${fmtMin(timing.totalMs)} · ${phaseLine(wait, think, out, timing.toolMs, fmtMin)}${
        otherShare >= 0.02 ? ` · 其它 ${fmtMin(timing.otherMs)}` : ""
      }`,
    });
  }

  return (
    <View style={{ gap: 7, minWidth: 360, maxWidth: 560 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
        {data.provider} 实时用量
      </Text>
      {rows.map((row) => (
        <Row key={row.label} label={row.label} value={row.value} color={row.color} theme={theme} />
      ))}
    </View>
  );
}

export function UsageDetails(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const { data } = useLiveUsage(agentId);
  const clock = useTurnClock(agentId);
  if (agentId.length === 0) return null;
  if (!data) {
    return <Text style={{ color: props.theme.colors.foregroundMuted }}>读取中…</Text>;
  }
  if (!data.supported) {
    return (
      <View style={{ gap: 6 }}>
        <Text style={{ color: props.theme.colors.foreground }}>实时用量</Text>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{data.reason}</Text>
      </View>
    );
  }
  return <Details data={data} theme={props.theme} clock={clock} />;
}
