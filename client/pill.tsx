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
import { fmtClock, fmtCost, fmtDur, fmtHit, fmtSec, fmtTps } from "./format.ts";
import { useLiveUsage } from "./use-live-usage.ts";
import { useTurnClock, type LiveTurnClock } from "./use-turn-clock.ts";

/** Label shown inside the composer pill, next to the icon. */
export function pillLabel(data: LiveUsageResult | undefined): string {
  if (!data) return "…";
  if (!data.supported) return "–";
  const parts: string[] = [];
  // Only measured rates ever reach the label.
  const tps = data.turnSpeed?.tokensPerSecond ?? data.last?.tokensPerSecond ?? null;
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
    useTurnClock(agentId);
    useEffect(() => {
      getHandle()?.update({ label: pillLabel(data) });
    }, [data]);
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

  // Everything below is a value the provider actually reported. Nothing is
  // derived from a price table, a character count, or a ratio.
  const fileTps = last?.tokensPerSecond ?? null;
  const speed = data.speed;
  const cost = data.cost ? fmtCost(data.cost.value, data.cost.currency) : null;
  const hit = last && last.hitPct !== null ? `${last.hitPct.toFixed(1)}%` : null;

  // This turn goes FIRST: it is what the user is watching right now. Every value
  // is wall clock measured from the timeline stream.
  const hasLiveTurn =
    clock.running || (clock.waitMs ?? 0) + clock.thinkMs + clock.outMs + clock.toolMs > 0;
  if (hasLiveTurn) {
    rows.push({
      label: "本轮",
      value: phaseLine(clock.waitMs, clock.thinkMs, clock.outMs, clock.toolMs, fmtSec),
    });
  }

  // Rates. `speed` carries the measured per-turn and whole-session rates, which
  // only exist where the log timestamps every streamed chunk. The rest have just
  // one call's wall clock, so that single measured rate is what they get.
  if (speed != null) {
    const rates: string[] = [];
    const turnTps = data.turnSpeed?.tokensPerSecond ?? null;
    if (turnTps !== null) rates.push(`本轮输出 ${fmtTps(turnTps)} t/s`);
    if (speed.tokensPerSecond != null) rates.push(`总输出 ${fmtTps(speed.tokensPerSecond)} t/s`);
    if (speed.ttftAvgMs != null) rates.push(`首字均 ${fmtSec(speed.ttftAvgMs)}`);
    if (rates.length > 0) rows.push({ label: "速度", value: rates.join(" · ") });
  } else if (fileTps !== null) {
    rows.push({ label: "速度", value: `${fmtTps(fileTps)} t/s` });
  }

  // Durations: the total first, then only the parts the store measured.
  if (speed != null) {
    const totalMs = speed.modelMs + speed.toolMs;
    const parts: string[] = [`等待首字 ${fmtDur(speed.ttftMs)}`];
    if (speed.thinkMs !== null && speed.outMs !== null) {
      parts.push(`思考 ${fmtDur(speed.thinkMs)}`, `输出 ${fmtDur(speed.outMs)}`);
    } else {
      // No reasoning records (devin, or a log predating them): keep the measured
      // generation window whole instead of splitting it into invented numbers.
      parts.push(`生成 ${fmtDur(speed.decodeMs)}`);
    }
    parts.push(`工具 ${fmtDur(speed.toolMs)}`);
    rows.push({ label: "耗时", value: `总 ${fmtDur(totalMs)} = ${parts.join(" + ")}` });
  } else if (data.timing && data.timing.totalMs > 0) {
    // No per-token timing, but the store still measured these walls and they add
    // up to the total exactly (request + other + tool). `其它` is real time the
    // adapter could not attribute to a model call or a tool (codex has this);
    // leaving it out would print an equation that does not hold.
    const timing = data.timing;
    const parts = [`模型 ${fmtDur(timing.requestMs)}`, `工具 ${fmtDur(timing.toolMs)}`];
    if (timing.otherMs > 0) parts.push(`其它 ${fmtDur(timing.otherMs)}`);
    rows.push({ label: "耗时", value: `总 ${fmtDur(timing.totalMs)} = ${parts.join(" + ")}` });
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
