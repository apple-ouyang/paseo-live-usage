/**
 * Provider adapters. Every provider stores usage somewhere different, and Paseo
 * only normalises a subset (it drops cache-write counts, and ACP providers like
 * dsh lose the buckets entirely). So each adapter reads the provider's own
 * session store and returns one normalized snapshot.
 *
 *   dsh       ~/.dsh/sessions/*\/<sid>/session.v<N>.jsonl.zstd + session_projcache
 *   pi        ~/.pi/agent/sessions/*\/*_<sid>.jsonl
 *   claude    ~/.claude/projects/*\/<sid>.jsonl
 *   codex     ~/.codex/sessions/**\/rollout-*<sid>.jsonl
 *   devin     ~/.local/share/devin/cli/sessions.db (message_nodes)
 *   fallback  Paseo `agent.lastUsage` (opencode, copilot, cursor, grok, kimi, …)
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readDevinUsage } from "./devin-usage.ts";
import { readDshUsage } from "./dsh-usage.ts";
import { piPhaseAggregate, type PhaseAggregate } from "./pi-phase.ts";
import { readAppendedJsonl } from "./incremental-jsonl.ts";

const MIN_SAMPLE_MS = 250;
const LIVE_WINDOW_MS = 12_000;

export type UsageSource =
  | "dsh-log"
  | "pi-session"
  | "claude-session"
  | "codex-session"
  | "devin-db"
  | "paseo-usage";

export interface StepMetrics {
  /** dsh's own turn/step counters; null when the provider has no such counter. */
  turn: number | null;
  step: number | null;
  output: number;
  reasoning: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  stepMs: number | null;
  tokensPerSecond: number | null;
  hitPct: number | null;
  endedAt: number | null;
}

export interface TotalsMetrics {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /**
   * Σ reasoning tokens (a subset of `output`). Undefined when the provider's
   * totals store does not report it; the client then falls back to the last
   * call's ratio instead.
   */
  reasoning?: number;
  hitPct: number | null;
}

export interface ContextMetrics {
  used: number;
  window: number;
  pressure: number | null;
}

export interface CostMetrics {
  value: number;
  currency: "USD" | "CNY";
  estimated: boolean;
  /** DeepSeek peak/off-peak window; null for provider-reported USD cost. */
  peak: boolean | null;
}

export interface TimingMetrics {
  /** Wall time inside turns (idle between turns excluded). */
  totalMs: number;
  /** Tool wall-clock, parallel batches counted once. */
  toolMs: number;
  /** Model request time. */
  requestMs: number;
  /**
   * Turn time not covered by request or tool. Bookkeeping entries never contribute
   * here because their gap is not provably work, so adapters that only measure
   * request/tool segments report 0; codex, whose task spans exceed its request+tool
   * gaps, reports the remainder.
   */
  otherMs: number;
}

/**
 * dsh's decode accounting, mirrored from `dsh-tui`'s trajectory aggregate: the
 * wait for the first streamed chunk is TTFT, the rest of the call is the decode
 * window, and tool execution sits outside both.
 */
export interface DecodeSpeedMetrics {
  /** Σ output tokens over the calls. */
  output: number;
  /** Σ (first chunk − step/start). */
  ttftMs: number;
  /** Σ (message landed − first chunk). */
  decodeMs: number;
  /** Calls that actually streamed, i.e. contributed TTFT and a decode span. */
  samples: number;
  /** output ÷ decodeMs — dsh's "输出速度 (TPS)". */
  tokensPerSecond: number | null;
  /** Σ reasoning-generation window; null when no call streamed thinking. */
  thinkMs: number | null;
  /**
   * `decodeMs − thinkMs`: everything generated after the first token that is not
   * thinking — the reply plus the tool-call arguments. Null without think data.
   */
  outMs: number | null;
}

export interface TurnSpeedMetrics extends DecodeSpeedMetrics {
  turn: number | null;
  /** TTFT + decode: the model-side wall clock. */
  modelMs: number;
}

export interface SpeedMetrics extends DecodeSpeedMetrics {
  turns: number;
  steps: number;
  modelMs: number;
  /** Tool wall clock, parallel batches counted once. */
  toolMs: number;
  /** ttftMs ÷ samples — dsh's "首 token 平均 (TTFT)". */
  ttftAvgMs: number | null;
}

export interface UsageSnapshot {
  source: UsageSource;
  sourceAgeMs: number;
  inFlight: boolean;
  last: StepMetrics | null;
  totals: TotalsMetrics | null;
  context: ContextMetrics | null;
  cost: CostMetrics | null;
  timing: TimingMetrics | null;
  /** Newest turn's decode accounting; dsh only for now. */
  turnSpeed?: TurnSpeedMetrics | null;
  /**
   * Whole-session decode accounting: dsh / pi / devin. Absent for providers
   * whose store has no per-token timing.
   */
  speed?: SpeedMetrics | null;
}

function emptyTiming(): TimingMetrics {
  return { totalMs: 0, toolMs: 0, requestMs: 0, otherMs: 0 };
}

/** Union length of half-open intervals (parallel tools share one wall clock). */
function unionMs(intervals: ReadonlyArray<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    const [nextStart, nextEnd] = sorted[index];
    if (nextStart > end) {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    } else if (nextEnd > end) {
      end = nextEnd;
    }
  }
  return total + (end - start);
}

/** Gap-accumulated timing (pi/claude): toolMs was added in place, only derive the rest. */
function finalizeTiming(timing: TimingMetrics): TimingMetrics {
  const toolMs = timing.toolMs;
  const requestMs = Math.min(timing.requestMs, Math.max(0, timing.totalMs - toolMs));
  return {
    totalMs: timing.totalMs,
    toolMs,
    requestMs,
    otherMs: Math.max(0, timing.totalMs - toolMs - requestMs),
  };
}

function finishTiming(timing: TimingMetrics, toolIntervals: ReadonlyArray<[number, number]>): TimingMetrics {
  const toolMs = unionMs(toolIntervals);
  const total = Math.max(timing.totalMs, timing.requestMs + timing.otherMs + toolMs);
  const requestMs = Math.min(timing.requestMs, Math.max(0, total - toolMs));
  return {
    totalMs: total,
    toolMs,
    requestMs,
    otherMs: Math.max(0, total - toolMs - requestMs),
  };
}

function addGap(timing: TimingMetrics, from: number | null, to: number | null, kind: "request" | "other"): void {
  if (from === null || to === null) return;
  const gap = to - from;
  if (gap <= 0) return;
  timing.totalMs += gap;
  if (kind === "request") timing.requestMs += gap;
  else timing.otherMs += gap;
}

export interface LastUsageLike {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface CollectInput {
  provider: string | null;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  lastUsage: LastUsageLike | null;
  /** Paseo says the agent is running; used by the fallback adapter only. */
  running?: boolean;
  home?: string;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hitRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  return percent(cacheRead, input + cacheRead + cacheWrite);
}

function stepSpeed(output: number, stepMs: number | null): number | null {
  if (stepMs === null || stepMs < MIN_SAMPLE_MS) return null;
  return output / (stepMs / 1000);
}

function makeTotals(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  reasoning = 0,
): TotalsMetrics {
  return { input, cacheRead, cacheWrite, output, reasoning, hitPct: hitRate(input, cacheRead, cacheWrite) };
}

/* ────────────────────────────── pricing ────────────────────────────── */

/** DeepSeek CNY list prices (元 / 1M tokens); peak = 2× off-peak. */
const FLASH = { offPeak: { hit: 0.02, miss: 1, out: 4 }, peak: { hit: 0.04, miss: 2, out: 8 } };
const PRO = { offPeak: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9, out: 27 } };
const WEEKEND_OFFPEAK_SINCE = Date.parse("2026-08-22T16:00:00Z");

function priceFor(model: string | null): { offPeak: typeof FLASH.offPeak; peak: typeof FLASH.peak } | null {
  if (!model) return null;
  const id = model.toLowerCase();
  if (!id.includes("deepseek")) return null;
  if (id.includes("flash")) return FLASH;
  if (id.includes("pro")) return PRO;
  return null;
}

function isPeak(atMs: number): boolean {
  const beijing = new Date(atMs + 8 * 3600_000);
  const day = beijing.getUTCDay();
  if (atMs >= WEEKEND_OFFPEAK_SINCE && (day === 0 || day === 6)) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

function estimateCny(
  model: string | null,
  input: number,
  cacheRead: number,
  output: number,
  atMs: number,
): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const rate = isPeak(atMs) ? price.peak : price.offPeak;
  const value = (cacheRead * rate.hit + input * rate.miss + output * rate.out) / 1_000_000;
  return value > 0 ? value : null;
}

/** dsh stores the model as a JSON array string, e.g. `["deepseek-official","deepseek-flash"]`. */
function normalizeModel(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const last = [...parsed].reverse().find((item) => typeof item === "string");
        if (typeof last === "string") return last;
      }
    } catch {
      // fall through to the raw value
    }
  }
  return trimmed;
}

/* ────────────────────────────── helpers ────────────────────────────── */

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Finds a session file by id across provider stores, optionally under a cwd dir. */
function findSessionFile(
  roots: string[],
  suffix: string,
  cwdDir?: { root: string; dir: string },
): string | null {
  for (const root of roots) {
    for (const entry of listDir(root)) {
      const dir = join(root, entry);
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const match = listDir(dir).find((file) => file.endsWith(suffix));
      if (match) return join(dir, match);
    }
  }
  if (cwdDir && existsSync(cwdDir.dir)) {
    const files = listDir(cwdDir.dir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    const newest = files[files.length - 1];
    if (newest) return join(cwdDir.dir, newest);
  }
  return null;
}

function newestMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/* ────────────────────────────── dsh ────────────────────────────── */

function dshSnapshot(sessionId: string, model: string | null, home: string): UsageSnapshot | null {
  const raw = readDshUsage(sessionId, home);
  if (!raw) return null;
  const estimate = raw.totals
    ? estimateCny(model, raw.totals.input, raw.totals.cacheRead, raw.totals.output, raw.observedAt)
    : null;
  return {
    source: "dsh-log",
    sourceAgeMs: raw.sourceAgeMs,
    inFlight: raw.inFlight,
    last: raw.last
      ? {
          turn: raw.last.turn,
          step: raw.last.step,
          output: raw.last.output,
          reasoning: raw.last.reasoning,
          input: raw.last.input,
          cacheRead: raw.last.cacheRead,
          cacheWrite: raw.last.cacheWrite,
          stepMs: raw.last.stepMs,
          tokensPerSecond: raw.last.tokensPerSecond,
          hitPct: raw.last.hitPct,
          endedAt: raw.last.endedAt,
        }
      : null,
    totals: raw.totals,
    context: raw.context,
    cost:
      estimate !== null
        ? { value: estimate, currency: "CNY", estimated: true, peak: isPeak(raw.observedAt) }
        : null,
    timing: raw.timing,
    turnSpeed: raw.turnSpeed,
    speed: raw.speed,
  };
}

/* ────────────────────────────── pi ────────────────────────────── */

interface PiState {
  last: StepMetrics | null;
  totals: TotalsMetrics;
  prevAt: number | null;
  inFlight: boolean;
  inTurn: boolean;
  timing: TimingMetrics;
  costUsd: number;
  changeAt: number;
  /** Real prompts seen, and assistant settlements (the panel's N 轮 M 步). */
  turns: number;
  steps: number;
}

const piStates = new Map<string, PiState>();

function piSnapshot(path: string, sessionId: string, home: string, now: number): UsageSnapshot {
  let state = piStates.get(path);
  if (!state) {
    state = {
      last: null,
      totals: makeTotals(0, 0, 0, 0),
      prevAt: null,
      inFlight: false,
      inTurn: false,
      timing: emptyTiming(),
      costUsd: 0,
      changeAt: now,
      turns: 0,
      steps: 0,
    };
    piStates.set(path, state);
  }
  const lines = readAppendedJsonl(path);
  if (lines.length > 0) state.changeAt = now;

  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    const at = parseTime(line.timestamp);
    const message = line.message as Record<string, unknown> | undefined;
    const role = message?.role;

    if (role === "user") {
      state.inFlight = true;
      state.inTurn = true;
      state.turns += 1;
      if (at !== null) state.prevAt = at;
      continue;
    }
    if (role === "toolResult") {
      state.inFlight = true;
      if (state.inTurn && at !== null && state.prevAt !== null) {
        const gap = at - state.prevAt;
        if (gap > 0) {
          state.timing.totalMs += gap;
          state.timing.toolMs += gap;
        }
      }
      if (at !== null) state.prevAt = at;
      continue;
    }
    if (role !== "assistant" || !message?.usage) {
      // Non-usage entries (session header, model/thinking-level changes, system
      // and custom messages, context edits) can land mid-turn. Counting their
      // gap would fold idle time in, and advancing the cursor or closing the
      // turn here would cut the in-flight request window short — the next
      // user/toolResult/assistant entry re-anchors itself.
      continue;
    }

    const usage = message.usage as Record<string, unknown>;
    const cost = usage.cost as Record<string, unknown> | undefined;
    const input = asNumber(usage.input);
    const cacheRead = asNumber(usage.cacheRead);
    const cacheWrite = asNumber(usage.cacheWrite);
    const output = asNumber(usage.output);
    const reasoning = asNumber(usage.reasoning);
    const endedAt = at ?? parseTime(message.timestamp);
    const stepMs =
      endedAt !== null && state.prevAt !== null ? Math.max(0, endedAt - state.prevAt) : null;

    state.last = {
      turn: null,
      step: null,
      output,
      reasoning,
      input,
      cacheRead,
      cacheWrite,
      stepMs,
      tokensPerSecond: stepSpeed(output, stepMs),
      hitPct: hitRate(input, cacheRead, cacheWrite),
      endedAt,
    };
    state.totals = makeTotals(
      state.totals.input + input,
      state.totals.cacheRead + cacheRead,
      state.totals.cacheWrite + cacheWrite,
      state.totals.output + output,
      (state.totals.reasoning ?? 0) + reasoning,
    );
    if (state.inTurn) addGap(state.timing, state.prevAt, endedAt, "request");
    if (cost && typeof cost.total === "number" && cost.total > 0) state.costUsd += cost.total;
    state.inFlight = false;
    state.steps += 1;
    if (endedAt !== null) state.prevAt = endedAt;
  }

  const timing = finalizeTiming(state.timing);
  // pi's statusline samples are the only source of per-call TTFT/decode; they
  // feed `speed`, and nothing else consumes the aggregate.
  const phase = piPhaseAggregate(home, path, sessionId);

  return {
    source: "pi-session",
    sourceAgeMs: Math.max(0, now - state.changeAt),
    inFlight: state.inFlight,
    last: state.last,
    totals: state.totals.output > 0 || state.totals.input > 0 ? state.totals : null,
    context: null,
    cost:
      state.costUsd > 0
        ? { value: state.costUsd, currency: "USD", estimated: false, peak: null }
        : null,
    timing,
    speed: phaseSpeed(phase, { turns: state.turns, steps: state.steps, toolMs: timing.toolMs }),
  };
}

/**
 * Turn pi's statusline samples into the same accounting dsh gets from its chunk
 * timestamps. The samples file is written by the pi statusline extension and
 * already carries per-call `ttftMs` / `decodeMs` / `out`, so no guessing.
 */
function phaseSpeed(
  phase: PhaseAggregate | null,
  session: { turns: number; steps: number; toolMs: number },
): SpeedMetrics | null {
  if (phase === null || phase.count === 0) return null;
  return {
    output: phase.output,
    ttftMs: phase.ttftMs,
    decodeMs: phase.decodeMs,
    samples: phase.count,
    modelMs: phase.ttftMs + phase.decodeMs,
    toolMs: session.toolMs,
    turns: session.turns,
    steps: session.steps,
    ttftAvgMs: phase.ttftMs / phase.count,
    tokensPerSecond: phase.decodeMs >= MIN_SAMPLE_MS ? phase.output / (phase.decodeMs / 1000) : null,
    // Absent `thinkMs` (older statusline rows) means unknown, not zero thinking.
    thinkMs: phase.thinkSamples > 0 ? phase.thinkMs : null,
    // Same definition as dsh: output is the decode window minus thinking, so the
    // panel's 生成 = 思考 + 输出 always closes instead of leaving a gap.
    outMs: phase.thinkSamples > 0 ? Math.max(0, phase.decodeMs - phase.thinkMs) : null,
  };
}

/* ────────────────────────────── claude ────────────────────────────── */

interface ClaudeBuckets {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

/**
 * Claude Code writes one assistant line per content block (thinking / text /
 * tool_use), all sharing the same message.id and the same full-message usage.
 * `startAt` is the prevAt captured when the FIRST block arrived, so stepMs
 * covers the whole request instead of just the last block's write interval.
 */
interface ClaudeMessage {
  buckets: ClaudeBuckets;
  startAt: number | null;
}

interface ClaudeState {
  last: StepMetrics | null;
  totals: TotalsMetrics;
  /** Claude Code writes the same assistant message more than once; key by message id. */
  messages: Map<string, ClaudeMessage>;
  prevAt: number | null;
  inFlight: boolean;
  inTurn: boolean;
  /** Outstanding tool_use blocks; the turn is open while this is > 0. */
  pendingToolCalls: number;
  timing: TimingMetrics;
  changeAt: number;
}

const claudeStates = new Map<string, ClaudeState>();

function claudeToolUseCount(message: Record<string, unknown> | undefined): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "tool_use") {
      count += 1;
    }
  }
  return count;
}

function isClaudeToolResult(message: Record<string, unknown> | undefined): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "tool_result",
  );
}

function claudeSnapshot(path: string, now: number): UsageSnapshot {
  let state = claudeStates.get(path);
  if (!state) {
    state = {
      last: null,
      totals: makeTotals(0, 0, 0, 0),
      messages: new Map(),
      prevAt: null,
      inFlight: false,
      inTurn: false,
      pendingToolCalls: 0,
      timing: emptyTiming(),
      changeAt: now,
    };
    claudeStates.set(path, state);
  }
  const lines = readAppendedJsonl(path);
  if (lines.length > 0) state.changeAt = now;

  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    const at = parseTime(line.timestamp);
    const type = line.type;
    const message = line.message as Record<string, unknown> | undefined;

    // Meta entries (local-command output, caveats, snapshots) are bookkeeping;
    // treating them as real prompts would re-anchor an in-flight request and
    // wipe the outstanding tool-call count.
    if (line.isMeta === true) continue;

    if (type === "user") {
      if (isClaudeToolResult(message)) {
        // tool_result comes back as a user entry: that gap is tool execution time.
        if (state.inTurn && at !== null && state.prevAt !== null) {
          const gap = at - state.prevAt;
          if (gap > 0) {
            state.timing.totalMs += gap;
            state.timing.toolMs += gap;
          }
        }
        if (state.pendingToolCalls > 0) state.pendingToolCalls -= 1;
      } else {
        // A real prompt starts a new turn; idle between turns is not counted.
        state.inTurn = true;
        state.pendingToolCalls = 0;
      }
      state.inFlight = true;
      if (at !== null) state.prevAt = at;
      continue;
    }
    if (type !== "assistant" || !message?.usage) {
      // Bookkeeping entries (queue-operation, attachment, progress, last-prompt, mode…)
      // are written both mid-turn and between turns, and their gap is never provably
      // work: between turns it is idle, and mid-turn it is unattributable. They are
      // also written mid-request (e.g. attachment lines land while a call is in
      // flight, sometimes with timestamps after the first block of that same
      // message), so they must NOT advance the cursor — that would cut the request
      // window short and drop wait/think time from the totals.
      continue;
    }

    const usage = message.usage as Record<string, unknown>;
    const details = usage.output_tokens_details as Record<string, unknown> | undefined;
    const buckets: ClaudeBuckets = {
      input: asNumber(usage.input_tokens),
      cacheRead: asNumber(usage.cache_read_input_tokens),
      cacheWrite: asNumber(usage.cache_creation_input_tokens),
      output: asNumber(usage.output_tokens),
      reasoning: details ? asNumber(details.thinking_tokens) : 0,
    };

    const id =
      typeof message.id === "string"
        ? message.id
        : typeof line.uuid === "string"
          ? line.uuid
          : `${at ?? 0}:${buckets.output}`;
    const record = state.messages.get(id);
    const previous = record?.buckets ?? {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
    };
    state.totals = makeTotals(
      state.totals.input + Math.max(0, buckets.input - previous.input),
      state.totals.cacheRead + Math.max(0, buckets.cacheRead - previous.cacheRead),
      state.totals.cacheWrite + Math.max(0, buckets.cacheWrite - previous.cacheWrite),
      state.totals.output + Math.max(0, buckets.output - previous.output),
      (state.totals.reasoning ?? 0) + Math.max(0, buckets.reasoning - previous.reasoning),
    );
    const startAt = record ? record.startAt : state.prevAt;
    state.messages.set(id, { buckets, startAt });

    const endedAt = at;
    const stepMs =
      endedAt !== null && startAt !== null ? Math.max(0, endedAt - startAt) : null;
    state.last = {
      turn: null,
      step: null,
      output: buckets.output,
      reasoning: buckets.reasoning,
      input: buckets.input,
      cacheRead: buckets.cacheRead,
      cacheWrite: buckets.cacheWrite,
      stepMs,
      tokensPerSecond: stepSpeed(buckets.output, stepMs),
      hitPct: hitRate(buckets.input, buckets.cacheRead, buckets.cacheWrite),
      endedAt,
    };
    // A model call always belongs to the turn, including continuation steps that follow
    // a bookkeeping entry. Open it here so the request gap is never dropped.
    state.inTurn = true;
    addGap(state.timing, state.prevAt, endedAt, "request");
    state.pendingToolCalls = claudeToolUseCount(message);
    state.inFlight = false;
    if (endedAt !== null) state.prevAt = endedAt;
  }

  return {
    source: "claude-session",
    sourceAgeMs: Math.max(0, now - state.changeAt),
    inFlight: state.inFlight,
    last: state.last,
    totals: state.totals.output > 0 || state.totals.input > 0 ? state.totals : null,
    context: null,
    cost: null,
    timing: finalizeTiming(state.timing),
  };
}

/* ────────────────────────────── codex ────────────────────────────── */

interface CodexState {
  last: StepMetrics | null;
  totals: TotalsMetrics | null;
  context: ContextMetrics | null;
  prevOutput: number | null;
  prevAt: number | null;
  inTurn: boolean;
  timing: TimingMetrics;
  toolStarts: Map<string, number>;
  toolIntervals: Array<[number, number]>;
  changeAt: number;
}

const codexStates = new Map<string, CodexState>();

function codexTotalsFrom(info: Record<string, unknown> | undefined): TotalsMetrics | null {
  if (!info) return null;
  const total = info.total_token_usage as Record<string, unknown> | undefined;
  if (!total) return null;
  const prompt = asNumber(total.input_tokens);
  const cacheRead = asNumber(total.cached_input_tokens);
  const cacheWrite = asNumber(total.cache_write_input_tokens);
  // OpenAI-style accounting counts cache reads inside input_tokens.
  const input = Math.max(0, prompt - cacheRead);
  return makeTotals(input, cacheRead, cacheWrite, asNumber(total.output_tokens), asNumber(total.reasoning_output_tokens));
}

interface CodexLast {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

function codexLastFrom(info: Record<string, unknown> | undefined): CodexLast | null {
  const last = info?.last_token_usage as Record<string, unknown> | undefined;
  if (!last) return null;
  const prompt = asNumber(last.input_tokens);
  const cacheRead = asNumber(last.cached_input_tokens);
  return {
    input: Math.max(0, prompt - cacheRead),
    cacheRead,
    cacheWrite: asNumber(last.cache_write_input_tokens),
    output: asNumber(last.output_tokens),
    reasoning: asNumber(last.reasoning_output_tokens),
  };
}

function codexSnapshot(path: string, now: number): UsageSnapshot {
  let state = codexStates.get(path);
  if (!state) {
    state = {
      last: null,
      totals: null,
      context: null,
      prevOutput: null,
      prevAt: null,
      inTurn: false,
      timing: emptyTiming(),
      toolStarts: new Map(),
      toolIntervals: [],
      changeAt: now,
    };
    codexStates.set(path, state);
  }
  const lines = readAppendedJsonl(path);
  if (lines.length > 0) state.changeAt = now;

  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    const payload = line.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    const kind = typeof payload.type === "string" ? payload.type : "";
    const at = parseTime(line.timestamp);

    if (kind === "task_started") {
      state.inTurn = true;
      if (at !== null) state.prevAt = at;
      continue;
    }
    if (kind === "task_complete" || kind === "turn_aborted") {
      if (state.inTurn) addGap(state.timing, state.prevAt, at, "other");
      state.inTurn = false;
      if (at !== null) state.prevAt = at;
      continue;
    }
    if (kind === "function_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if (callId && at !== null) state.toolStarts.set(callId, at);
      if (state.inTurn) addGap(state.timing, state.prevAt, at, "other");
      if (at !== null) state.prevAt = at;
      continue;
    }
    if (kind === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const startedAt = state.toolStarts.get(callId);
      if (startedAt !== undefined && at !== null && at > startedAt) {
        state.toolIntervals.push([startedAt, at]);
      }
      state.toolStarts.delete(callId);
      if (at !== null) state.prevAt = at;
      continue;
    }

    if (kind === "token_count") {
      const info = payload.info as Record<string, unknown> | undefined;
      const totals = codexTotalsFrom(info);
      if (totals) state.totals = totals;

      const window_ = optionalNumber(info?.model_context_window);
      // Context occupancy is the LAST request's prompt, not the cumulative session total.
      const lastUsageInfo = info?.last_token_usage as Record<string, unknown> | undefined;
      const used = lastUsageInfo
        ? asNumber(lastUsageInfo.total_tokens)
        : totals
          ? totals.input + totals.cacheRead + totals.output
          : null;
      if (window_ !== null && used !== null && used > 0) {
        state.context = { used, window: window_, pressure: null };
      }

      const last = codexLastFrom(info);
      if (last) {
        const cumulativeOutput = totals?.output ?? null;
        let tps: number | null = null;
        if (
          cumulativeOutput !== null &&
          state.prevOutput !== null &&
          at !== null &&
          state.prevAt !== null
        ) {
          const dt = at - state.prevAt;
          const delta = cumulativeOutput - state.prevOutput;
          if (dt >= MIN_SAMPLE_MS && delta > 0) tps = delta / (dt / 1000);
        }
        if (cumulativeOutput !== null) state.prevOutput = cumulativeOutput;
        state.last = {
          turn: null,
          step: null,
          output: last.output,
          reasoning: last.reasoning,
          input: last.input,
          cacheRead: last.cacheRead,
          cacheWrite: last.cacheWrite,
          stepMs: null,
          tokensPerSecond: tps,
          hitPct: hitRate(last.input, last.cacheRead, last.cacheWrite),
          endedAt: at,
        };
      }
    }

    if (state.inTurn) addGap(state.timing, state.prevAt, at, "request");
    if (at !== null) state.prevAt = at;
  }

  return {
    source: "codex-session",
    sourceAgeMs: Math.max(0, now - state.changeAt),
    inFlight: state.inTurn,
    last: state.last,
    totals: state.totals,
    context: state.context,
    cost: null,
    timing: finishTiming(state.timing, state.toolIntervals),
  };
}

/* ────────────────────────────── devin ────────────────────────────── */

function devinSnapshot(sessionId: string, home: string, now: number): UsageSnapshot | null {
  const raw = readDevinUsage(sessionId, home, now);
  if (!raw) return null;
  const speed = raw.speed;
  return {
    source: "devin-db",
    sourceAgeMs: raw.sourceAgeMs,
    inFlight: raw.inFlight,
    last: raw.last ? { turn: null, step: null, ...raw.last } : null,
    totals: raw.totals,
    context: raw.context,
    cost: null,
    timing: raw.timing,
    speed:
      speed === null
        ? null
        : {
            output: speed.output,
            ttftMs: speed.ttftMs,
            decodeMs: speed.decodeMs,
            samples: speed.samples,
            modelMs: speed.ttftMs + speed.decodeMs,
            toolMs: speed.toolMs,
            turns: speed.turns,
            steps: speed.steps,
            ttftAvgMs: speed.samples > 0 ? speed.ttftMs / speed.samples : null,
            tokensPerSecond:
              speed.decodeMs >= MIN_SAMPLE_MS ? speed.output / (speed.decodeMs / 1000) : null,
            // devin reports no thinking/output split, only the TTFT.
            thinkMs: null,
            outMs: null,
          },
  };
}

/* ────────────────────────────── paseo lastUsage fallback ────────────────────────────── */

interface LiveSample {
  at: number;
  output: number;
}

const liveSamples = new Map<string, LiveSample[]>();

/** Providers whose `inputTokens` already contains the cache reads. */
function inputIncludesCached(provider: string | null): boolean {
  return /codex|openai|gpt/i.test(provider ?? "");
}

function liveSpeed(agentId: string, output: number, now: number): number | null {
  let samples = liveSamples.get(agentId);
  if (!samples) {
    samples = [];
    liveSamples.set(agentId, samples);
  }
  const last = samples[samples.length - 1];
  if (!last || last.output !== output) samples.push({ at: now, output });
  while (samples.length > 2 && now - samples[0].at > LIVE_WINDOW_MS) samples.shift();
  if (samples.length < 2) return null;
  const first = samples[0];
  const newest = samples[samples.length - 1];
  const dt = newest.at - first.at;
  const delta = newest.output - first.output;
  if (dt < MIN_SAMPLE_MS || delta <= 0) return null;
  return delta / (dt / 1000);
}

function passthroughSnapshot(agentId: string, input: CollectInput, now: number): UsageSnapshot | null {
  const usage = input.lastUsage;
  if (!usage) return null;
  const prompt = asNumber(usage.inputTokens);
  const cacheRead = asNumber(usage.cachedInputTokens);
  const output = asNumber(usage.outputTokens);
  const normalizedInput = inputIncludesCached(input.provider) ? Math.max(0, prompt - cacheRead) : prompt;
  const cost = optionalNumber(usage.totalCostUsd);
  const contextUsed = optionalNumber(usage.contextWindowUsedTokens);
  const contextMax = optionalNumber(usage.contextWindowMaxTokens);
  const hasTokens = prompt > 0 || cacheRead > 0 || output > 0;

  return {
    source: "paseo-usage",
    sourceAgeMs: 0,
    inFlight: input.running === true,
    last: hasTokens
      ? {
          turn: null,
          step: null,
          output,
          reasoning: 0,
          input: normalizedInput,
          cacheRead,
          cacheWrite: 0,
          stepMs: null,
          tokensPerSecond: liveSpeed(agentId, output, now),
          hitPct: hitRate(normalizedInput, cacheRead, 0),
          endedAt: null,
        }
      : null,
    totals: null,
    context:
      contextUsed !== null && contextMax !== null
        ? { used: contextUsed, window: contextMax, pressure: null }
        : null,
    cost: cost !== null && cost > 0 ? { value: cost, currency: "USD", estimated: false, peak: null } : null,
    timing: null,
  };
}

/* ────────────────────────────── dispatch ────────────────────────────── */

/**
 * Resolved session-file paths, keyed by provider:sessionId. Without this the
 * providers' directory scan (all of ~/.claude/projects, the codex tree, …)
 * runs on every poll for every visible agent.
 */
const sessionFileCache = new Map<string, string>();

function cachedSessionFile(key: string, resolve: () => string | null): string | null {
  const cached = sessionFileCache.get(key);
  if (cached !== undefined && existsSync(cached)) return cached;
  const found = resolve();
  if (found) sessionFileCache.set(key, found);
  else sessionFileCache.delete(key);
  return found;
}

function withContextFallback(snapshot: UsageSnapshot, input: CollectInput): UsageSnapshot {
  if (snapshot.context === null) {
    const used = optionalNumber(input.lastUsage?.contextWindowUsedTokens);
    const max = optionalNumber(input.lastUsage?.contextWindowMaxTokens);
    if (used !== null && max !== null) snapshot.context = { used, window: max, pressure: null };
  }
  if (snapshot.cost === null) {
    const cost = optionalNumber(input.lastUsage?.totalCostUsd);
    if (cost !== null && cost > 0) snapshot.cost = { value: cost, currency: "USD", estimated: false, peak: null };
  }
  // Paseo's running flag is authoritative when present: it clears the stuck
  // "in flight" state a file tail can leave behind after a crash/abort, and it
  // keeps the indicator on between the parts of a multi-block message.
  if (input.running !== undefined) snapshot.inFlight = input.running;
  return snapshot;
}

export function collectUsage(agentId: string, input: CollectInput): UsageSnapshot | null {
  const home = input.home ?? homedir();
  const now = Date.now();
  const model = normalizeModel(input.model);

  if (input.provider === "dsh" && input.sessionId) {
    const snapshot = dshSnapshot(input.sessionId, model, home);
    if (snapshot) return withContextFallback(snapshot, input);
  }

  if (input.sessionId) {
    if (input.provider === "pi") {
      const sessionId = input.sessionId;
      const path = cachedSessionFile(`pi:${sessionId}`, () =>
        findSessionFile([join(home, ".pi", "agent", "sessions")], `_${sessionId}.jsonl`),
      );
      if (path) return withContextFallback(piSnapshot(path, input.sessionId, home, now), input);
    }
    // Custom providers that `extends: "claude"` (e.g. claude-cpa) still run the
    // Claude Code binary and write the same ~/.claude/projects transcripts.
    if (input.provider === "claude" || input.provider?.startsWith("claude-")) {
      const sessionId = input.sessionId;
      const path = cachedSessionFile(`claude:${sessionId}`, () =>
        findSessionFile([join(home, ".claude", "projects")], `${sessionId}.jsonl`),
      );
      if (path) return withContextFallback(claudeSnapshot(path, now), input);
    }
    if (input.provider === "codex") {
      const sessionId = input.sessionId;
      const path = cachedSessionFile(`codex:${sessionId}`, () => findCodexFile(home, sessionId));
      if (path) return withContextFallback(codexSnapshot(path, now), input);
    }
    if (input.provider === "devin") {
      const snapshot = devinSnapshot(input.sessionId, home, now);
      if (snapshot) return withContextFallback(snapshot, input);
    }
  }

  const fallback = passthroughSnapshot(agentId, input, now);
  return fallback ? withContextFallback(fallback, input) : null;
}

function findCodexFile(home: string, sessionId: string): string | null {
  const root = join(home, ".codex", "sessions");
  if (!existsSync(root)) return null;
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return null;
  }
  const match = entries.find((entry) => entry.endsWith(".jsonl") && entry.includes(sessionId));
  return match ? join(root, match) : null;
}

export function sessionFileAge(path: string): number {
  const mtime = newestMtime(path);
  return mtime > 0 ? Math.max(0, Date.now() - mtime) : 0;
}
