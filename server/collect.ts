/**
 * Provider adapters. Every provider stores usage somewhere different, and Paseo
 * only normalises a subset (it drops cache-write counts, and ACP providers like
 * dsh lose the buckets entirely). So each adapter reads the provider's own
 * session store and returns one normalized snapshot.
 *
 *   dsh       ~/.dsh/sessions/*\/<sid>/session.v<N>.jsonl.zstd + session_projcache
 *   pi        ~/.pi/agent/sessions/*\/*_<sid>.jsonl
 *   claude    ~/.claude/projects/*\/<sid>.jsonl
 *   codex     ~/.codex/sessions/**\/rollout-*<sid>.jsonl (+ archived_sessions)
 *   grok      ~/.grok/sessions/<cwd>/<sid>/{events,usage}.json(l)
 *   devin     ~/.local/share/devin/cli/sessions.db (message_nodes)
 *   droid     ~/.factory/sessions/<cwd>/<sid>.jsonl + <sid>.settings.json
 *   agy       ~/.gemini/antigravity-cli/conversations/<conv>.db (gen_metadata)
 *   fallback  Paseo `agent.lastUsage` (opencode, copilot, cursor, grok, kimi, …)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAgyUsage } from "./antigravity-usage.ts";
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
  | "grok-session"
  | "devin-db"
  | "droid-session"
  | "agy-db"
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
  /** Store-counted prompt turns / model calls, when no `speed` carries them. */
  turns?: number;
  steps?: number;
  hitPct: number | null;
}

export interface ContextMetrics {
  used: number;
  window: number;
  pressure: number | null;
}

/** Cost as the provider itself reports it. Never derived from a price table. */
export interface CostMetrics {
  value: number;
  currency: "USD" | "CNY";
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
   * request/tool segments report 0.
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
  /**
   * Newest single call, exactly as the store measured it. pi's statusline writes
   * one row per call, so this is the only place the plugin can show a real
   * "latest" speed: `tokensPerSecond` here divides by the decode window, not by a
   * request wall clock that includes the first-token wait.
   */
  latest?: LatestCallMetrics | null;
}

export interface LatestCallMetrics {
  ttftMs: number;
  decodeMs: number;
  output: number;
  tokensPerSecond: number | null;
  /** Epoch ms of the sample, or null when the row carried no `t`. */
  at: number | null;
  /** That call's thinking window; null when the row carried no `thinkMs`. */
  thinkMs: number | null;
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

function dshSnapshot(sessionId: string, home: string): UsageSnapshot | null {
  const raw = readDshUsage(sessionId, home);
  if (!raw) return null;
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
    // dsh's session store carries no cost field, and this plugin does not invent
    // one from a price table.
    cost: null,
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

    // An aborted or otherwise empty settlement reports no tokens at all (`stopReason:
    // "aborted"`, or a call killed before it streamed). It measured nothing, so it
    // must not become `last`: doing that wipes the pill's speed AND hit rate and
    // leaves only the session hit rate (实测 2026-11-12: 胶囊只剩「95%」). The wall
    // clock still advances, otherwise the next call's step window would swallow the
    // aborted span.
    if (input + cacheRead + cacheWrite + output === 0) {
      if (state.inTurn) addGap(state.timing, state.prevAt, endedAt, "request");
      state.inFlight = false;
      if (endedAt !== null) state.prevAt = endedAt;
      continue;
    }

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
        ? { value: state.costUsd, currency: "USD" }
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
    latest: phase.latest
      ? {
          ttftMs: phase.latest.ttftMs,
          decodeMs: phase.latest.decodeMs,
          output: phase.latest.output,
          tokensPerSecond:
            phase.latest.decodeMs >= MIN_SAMPLE_MS
              ? phase.latest.output / (phase.latest.decodeMs / 1000)
              : null,
          at: phase.latest.t,
          thinkMs: phase.latest.thinkMs,
        }
      : null,
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
  /** Latest `cost-state.totalCostUSD` Claude Code wrote for this session. */
  costUsd: number;
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
      costUsd: 0,
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
    // Claude Code appends session-cumulative `cost-state` rows carrying the real
    // USD cost. Keep the highest seen (it only grows).
    if (type === "cost-state") {
      const total = line.totalCostUSD;
      if (typeof total === "number" && Number.isFinite(total) && total > state.costUsd) {
        state.costUsd = total;
      }
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
    cost: state.costUsd > 0 ? { value: state.costUsd, currency: "USD" } : null,
    timing: finalizeTiming(state.timing),
  };
}

/* ────────────────────────────── codex ────────────────────────────── */

/**
 * Codex writes one `item_completed` event per streamed item, and each carries
 * the item's real `[started_at_ms, completed_at_ms]` window. `Reasoning` is the
 * thinking stream, `AgentMessage` the reply text, and the tool items are tool
 * execution — the same three phases dsh gets from its per-chunk timestamps.
 */
const CODEX_THINK_ITEM = "Reasoning";
const CODEX_OUTPUT_ITEM = "AgentMessage";
const CODEX_TOOL_ITEMS = new Set([
  "CommandExecution",
  "McpToolCall",
  "FileChange",
  "WebSearch",
  "SubAgentActivity",
  "CollabAgentToolCall",
  "ImageView",
]);

type PhaseWindow = [number, number];

interface CodexTurn {
  turnId: string | null;
  startedAt: number;
  completedAt: number | null;
  /** Cumulative session totals when the turn opened; the deltas are below. */
  outputAtStart: number;
  reasoningAtStart: number;
  output: number;
  reasoning: number;
  think: PhaseWindow[];
  out: PhaseWindow[];
  /** Tool windows from `item_completed` (real exec start/end). */
  itemTool: PhaseWindow[];
  /** Tool windows from call/output pairs, for logs without item timings. */
  pairTool: PhaseWindow[];
}

interface CodexState {
  last: StepMetrics | null;
  totals: TotalsMetrics | null;
  context: ContextMetrics | null;
  /** `token_count` records seen: one per settled model call, the panel's 步. */
  calls: number;
  /** Cumulative output/reasoning tokens, straight from `total_token_usage`. */
  cumulativeOutput: number;
  cumulativeReasoning: number;
  order: string[];
  turns: Map<string, CodexTurn>;
  openTurnId: string | null;
  /** Newest event timestamp; an open turn's span ends here. */
  lastEventAt: number;
  /** call_id -> start, for `custom_tool_call` / `function_call` pairs. */
  toolStarts: Map<string, number>;
  changeAt: number;
}

const codexStates = new Map<string, CodexState>();

/** Codex's `duration` field: `{secs, nanos}`. */
function codexDurationMs(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const secs = (value as { secs?: unknown }).secs;
  const nanos = (value as { nanos?: unknown }).nanos;
  const seconds = typeof secs === "number" && Number.isFinite(secs) ? secs : 0;
  const fraction = typeof nanos === "number" && Number.isFinite(nanos) ? nanos : 0;
  const ms = seconds * 1000 + fraction / 1e6;
  return ms > 0 ? ms : null;
}

/**
 * The item's measured window. Newer rollouts carry `started_at_ms`; older ones
 * only `completed_at_ms` plus the item's own `duration`. A zero-length window is
 * returned as null: Codex does write `completed == started` for instant reads,
 * and a 0ms generation window would be a fabricated number, not a measurement.
 */
function codexItemWindow(payload: Record<string, unknown>): PhaseWindow | null {
  const item = payload.item as Record<string, unknown> | undefined;
  if (!item) return null;
  const end = optionalNumber(payload.completed_at_ms);
  const start = optionalNumber(payload.started_at_ms);
  if (start !== null && end !== null && end > start) return [start, end];
  const duration = codexDurationMs(item.duration);
  if (end !== null && duration !== null) return [end - duration, end];
  return null;
}

function codexTurnFor(state: CodexState, turnId: string | null): CodexTurn | undefined {
  if (turnId !== null) {
    const turn = state.turns.get(turnId);
    if (turn) return turn;
  }
  return state.openTurnId !== null ? state.turns.get(state.openTurnId) : undefined;
}

/** Item windows when the log has them, else the call/output pair windows. */
function codexTurnToolWindows(turn: CodexTurn): PhaseWindow[] {
  return turn.itemTool.length > 0 ? turn.itemTool : turn.pairTool;
}

/**
 * Model calls inside one turn, for the panel's "首字均". A call is one run of
 * generation windows; a tool window ends the run, so the next reasoning or
 * reply window opens the following call. Counting turns instead would make a
 * 195-call turn look like a single 37-minute first-token wait.
 */
function codexTurnCalls(turn: CodexTurn): number {
  const windows = [
    ...turn.think.map(([start, end]) => ({ start, end, tool: false })),
    ...turn.out.map(([start, end]) => ({ start, end, tool: false })),
    ...codexTurnToolWindows(turn).map(([start, end]) => ({ start, end, tool: true })),
  ].sort((a, b) => a.start - b.start);
  let calls = 0;
  let open = false;
  for (const window of windows) {
    if (window.tool) {
      open = false;
      continue;
    }
    if (!open) {
      calls += 1;
      open = true;
    }
  }
  return calls;
}

/**
 * True when a turn's measured windows cannot cover the tokens it produced.
 *
 * Two mirror cases, both real in this machine's rollouts:
 *   - `reasoning`: Codex recorded reasoning tokens but wrote a zero-length
 *     `Reasoning` window, so the thinking is real and untimed.
 *   - `output`: output tokens beyond the reasoning ones (tool-call arguments, or
 *     a reply written with a zero-length `AgentMessage` window) that no output
 *     window covers.
 *
 * Either way the split and the rate are unknown: dividing those tokens by the
 * windows that do exist would invent both. Almost all of these turns are failed
 * turns (overloaded / interrupted / unauthorized).
 */
function codexUntimedGeneration(turn: CodexTurn): { reasoning: boolean; output: boolean } {
  return {
    reasoning: turn.reasoning > 0 && unionMs(turn.think) < MIN_SAMPLE_MS,
    output: turn.out.length === 0 && turn.output - turn.reasoning > 0,
  };
}

/**
 * One turn's decode accounting, on the same definition dsh uses: the wait for
 * the first streamed token, then the generation window split into thinking and
 * the reply, with tool execution outside both.
 *
 * Codex's turn span is the whole agent loop — several model calls plus the tool
 * runs between them. The reasoning and reply windows are measured; so is tool
 * execution; everything left over is model request latency before a call's
 * first streamed item, i.e. the per-call TTFT. Putting that remainder in
 * `ttftMs` keeps `span = 等待首字 + 思考 + 输出 + 工具` exact instead of inventing
 * a decode window the log never measured.
 *
 * A turn whose items were never recorded (a forked session replaying its
 * ancestor's turn) has no window at all: it returns null so it cannot claim a
 * span it cannot prove. A turn whose windows exist but do not cover its tokens
 * (`codexUntimedGeneration`) still returns a bucket — its spans are real, it is
 * the split and the rate that go to null.
 */
function codexTurnSpeed(turn: CodexTurn, openEnd: number): TurnSpeedMetrics | null {
  const tool = codexTurnToolWindows(turn);
  if (turn.think.length === 0 && turn.out.length === 0 && tool.length === 0) return null;
  const end = turn.completedAt ?? openEnd;
  const span = Math.max(0, end - turn.startedAt);
  const thinkMs = unionMs(turn.think);
  const outWindowMs = unionMs(turn.out);
  const toolMs = unionMs(tool);
  const decodeMs = thinkMs + outWindowMs;
  const ttftMs = Math.max(0, span - decodeMs - toolMs);
  const untimed = codexUntimedGeneration(turn);
  const hasThinking = thinkMs >= MIN_SAMPLE_MS;
  return {
    turn: null,
    output: turn.output,
    ttftMs,
    decodeMs,
    samples: codexTurnCalls(turn),
    tokensPerSecond:
      !untimed.reasoning && !untimed.output && turn.output > 0 && decodeMs >= MIN_SAMPLE_MS
        ? turn.output / (decodeMs / 1000)
        : null,
    // Absent/untimed thinking or output means unknown, not zero — the client
    // then shows the measured 生成 window whole, exactly as it does for devin.
    thinkMs: hasThinking && !untimed.output ? thinkMs : null,
    outMs: hasThinking && !untimed.output ? outWindowMs : null,
    modelMs: ttftMs + decodeMs,
  };
}

function codexSpeeds(state: CodexState): { speed: SpeedMetrics | null; turnSpeed: TurnSpeedMetrics | null } {
  const buckets: Array<{ speed: TurnSpeedMetrics; toolMs: number }> = [];
  let turnSpeed: TurnSpeedMetrics | null = null;
  for (const id of state.order) {
    const turn = state.turns.get(id);
    if (!turn) continue;
    if (turn.completedAt === null) {
      // Still running: the tokens it has already spent belong to the live
      // totals, so the panel's rate moves while the turn is in flight instead
      // of sitting at 0 until the turn lands.
      turn.output = Math.max(0, state.cumulativeOutput - turn.outputAtStart);
      turn.reasoning = Math.max(0, state.cumulativeReasoning - turn.reasoningAtStart);
    }
    const bucket = codexTurnSpeed(turn, state.lastEventAt);
    if (!bucket) continue;
    // The newest measured turn supplies 本轮 even when its own split is unknown
    // (still running, or the model failed).
    turnSpeed = bucket;
    // A turn whose windows do not cover the tokens it produced cannot join the
    // rate: its output would be divided by a window that never held it. Those
    // are almost all failed turns (overloaded / interrupted / unauthorized —
    // 23 of the 26 untimed-output turns in the newest 60 rollouts). The rule is
    // the same one grok uses for turns its ledger never recorded: keep them out
    // of `speed` entirely (numerator and denominator together) and leave their
    // spans to the fallback row, so one failed turn cannot blank a long
    // session's rate forever.
    const untimed = codexUntimedGeneration(turn);
    if (untimed.reasoning || untimed.output) continue;
    buckets.push({ speed: bucket, toolMs: unionMs(codexTurnToolWindows(turn)) });
  }
  if (turnSpeed === null) return { speed: null, turnSpeed: null };
  if (buckets.length === 0) return { speed: null, turnSpeed };

  let output = 0;
  let ttftMs = 0;
  let decodeMs = 0;
  let thinkMs = 0;
  let toolMs = 0;
  let samples = 0;
  let thinkSamples = 0;
  for (const bucket of buckets) {
    output += bucket.speed.output;
    ttftMs += bucket.speed.ttftMs;
    decodeMs += bucket.speed.decodeMs;
    toolMs += bucket.toolMs;
    samples += bucket.speed.samples;
    if (bucket.speed.thinkMs !== null) {
      thinkMs += bucket.speed.thinkMs;
      thinkSamples += 1;
    }
  }
  return {
    turnSpeed,
    speed: {
      output,
      ttftMs,
      decodeMs,
      samples,
      tokensPerSecond: output > 0 && decodeMs >= MIN_SAMPLE_MS ? output / (decodeMs / 1000) : null,
      thinkMs: thinkSamples > 0 ? thinkMs : null,
      // Output is the decode window minus thinking, so 生成 = 思考 + 输出 closes.
      outMs: thinkSamples > 0 ? Math.max(0, decodeMs - thinkMs) : null,
      turns: buckets.length,
      steps: state.calls,
      modelMs: ttftMs + decodeMs,
      toolMs,
      ttftAvgMs: samples > 0 ? ttftMs / samples : null,
    },
  };
}

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

/** Closes the open turn with Codex's own end time when it reports one. */
function codexCloseTurn(state: CodexState, key: string | null, payload: Record<string, unknown>, at: number | null): void {
  const completedAt = optionalNumber(payload.completed_at);
  const end = completedAt !== null ? completedAt * 1000 : at;
  const turn = key !== null ? state.turns.get(key) : undefined;
  if (turn) {
    turn.completedAt = end;
    // `total_token_usage` is cumulative and its final record lands before
    // `task_complete`, so these deltas are the turn's own usage exactly.
    turn.output = Math.max(0, state.cumulativeOutput - turn.outputAtStart);
    turn.reasoning = Math.max(0, state.cumulativeReasoning - turn.reasoningAtStart);
  }
  state.openTurnId = null;
}

function codexSnapshot(path: string, now: number): UsageSnapshot {
  let state = codexStates.get(path);
  if (!state) {
    state = {
      last: null,
      totals: null,
      context: null,
      calls: 0,
      cumulativeOutput: 0,
      cumulativeReasoning: 0,
      order: [],
      turns: new Map(),
      openTurnId: null,
      lastEventAt: 0,
      toolStarts: new Map(),
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
    if (at !== null && at > state.lastEventAt) state.lastEventAt = at;

    if (kind === "task_started") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      const key = turnId ?? `turn-${state.order.length + 1}`;
      // `completed_at - started_at` equals `duration_ms` exactly, while the
      // event timestamp is written when the record lands — about a second late
      // normally, and at fork time (copying an ancestor's whole turn) much
      // later than the turn itself. So the reported start wins, and the event
      // timestamp is only the fallback for records that omit it.
      const startedAt = optionalNumber(payload.started_at);
      if (!state.turns.has(key)) {
        state.turns.set(key, {
          turnId,
          startedAt: startedAt !== null ? startedAt * 1000 : at ?? state.lastEventAt,
          completedAt: null,
          outputAtStart: state.cumulativeOutput,
          reasoningAtStart: state.cumulativeReasoning,
          output: 0,
          reasoning: 0,
          think: [],
          out: [],
          itemTool: [],
          pairTool: [],
        });
        state.order.push(key);
      }
      state.openTurnId = key;
      continue;
    }

    if (kind === "task_complete" || kind === "turn_aborted") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      // A forked session replays its ancestor's turn and closes it with the
      // original `completed_at`, so the reported end time wins over the
      // (fork-time) event timestamp.
      const key = turnId !== null && state.turns.has(turnId) ? turnId : state.openTurnId;
      codexCloseTurn(state, key, payload, at);
      continue;
    }

    if (kind === "item_completed") {
      const window = codexItemWindow(payload);
      if (window) {
        const item = payload.item as Record<string, unknown> | undefined;
        const type = typeof item?.type === "string" ? item.type : "";
        const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
        const turn = codexTurnFor(state, turnId);
        if (turn) {
          if (type === CODEX_THINK_ITEM) turn.think.push(window);
          else if (type === CODEX_OUTPUT_ITEM) turn.out.push(window);
          else if (CODEX_TOOL_ITEMS.has(type)) turn.itemTool.push(window);
        }
      }
      continue;
    }

    // Legacy shells: `function_call` and its newer `custom_tool_call` twin are
    // the only tool timing an item-less rollout has.
    if (kind === "function_call" || kind === "custom_tool_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if (callId && at !== null) state.toolStarts.set(callId, at);
      continue;
    }
    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const startedAt = state.toolStarts.get(callId);
      state.toolStarts.delete(callId);
      if (startedAt !== undefined && at !== null && at > startedAt) {
        const turn = state.openTurnId !== null ? state.turns.get(state.openTurnId) : undefined;
        if (turn) turn.pairTool.push([startedAt, at]);
      }
      continue;
    }

    if (kind === "token_count") {
      state.calls += 1;
      const info = payload.info as Record<string, unknown> | undefined;
      const totals = codexTotalsFrom(info);
      if (totals) {
        state.totals = totals;
        state.cumulativeOutput = totals.output;
        state.cumulativeReasoning = totals.reasoning ?? 0;
      }

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
        state.last = {
          turn: null,
          step: null,
          output: last.output,
          reasoning: last.reasoning,
          input: last.input,
          cacheRead: last.cacheRead,
          cacheWrite: last.cacheWrite,
          // The call's own decode window is only known once its items land; the
          // panel's rates come from the turn buckets instead.
          stepMs: null,
          tokensPerSecond: null,
          hitPct: hitRate(last.input, last.cacheRead, last.cacheWrite),
          endedAt: at,
        };
      }
    }
  }

  const speeds = codexSpeeds(state);
  // Fallback row, for logs with no item timings at all: every measured turn span
  // is model-side wall clock once tool execution is taken out. It covers EVERY
  // turn — including the ones `speed` left out (replayed ancestor turns, failed
  // turns) — because it is what the client shows when `speed` is null.
  let totalMs = 0;
  const sessionTool: PhaseWindow[] = [];
  for (const id of state.order) {
    const turn = state.turns.get(id);
    if (!turn) continue;
    totalMs += Math.max(0, (turn.completedAt ?? state.lastEventAt) - turn.startedAt);
    sessionTool.push(...codexTurnToolWindows(turn));
  }
  const toolMs = unionMs(sessionTool);
  const timing: TimingMetrics = {
    totalMs,
    toolMs,
    requestMs: Math.max(0, totalMs - toolMs),
    otherMs: 0,
  };
  // The pill prefers the newest turn's rate; when that turn has no measured
  // window yet, the session's measured rate is the honest fallback.
  if (state.last) {
    state.last.tokensPerSecond =
      speeds.turnSpeed?.tokensPerSecond ?? speeds.speed?.tokensPerSecond ?? null;
  }

  return {
    source: "codex-session",
    sourceAgeMs: Math.max(0, now - state.changeAt),
    inFlight: state.openTurnId !== null,
    last: state.last,
    totals: state.totals,
    context: state.context,
    cost: null,
    timing,
    turnSpeed: speeds.turnSpeed,
    speed: speeds.speed,
  };
}

/* ────────────────────────────── grok ────────────────────────────── */

/**
 * Grok's session directory holds the two halves the panel needs:
 *
 *   events.jsonl  append-only turn timeline — `turn_started` / `turn_ended`,
 *                 `loop_started`, `phase_changed`, `tool_started/completed`
 *   usage.json    the CLI's own token + cost ledger (`grok usage <sid>` prints
 *                 the same JSON); it is rewritten when a turn settles
 *
 * The phase timeline yields every part of the 耗时 split, the ledger yields the
 * tokens, the cache hit rate and the real USD cost. `phase_changed` repeats the
 * current phase once per chunk, so an interval only opens on a real change.
 */
const GROK_THINK_PHASE = "streaming_reasoning";
const GROK_OUT_PHASE = "streaming_text";
const GROK_TOOL_PHASE = "tool_execution";

interface GrokTurn {
  turnNumber: number | null;
  startedAt: number;
  endedAt: number | null;
  /** `loop_started` records: one per model call, the panel's 步. */
  loops: number;
  think: PhaseWindow[];
  out: PhaseWindow[];
  tool: PhaseWindow[];
}

interface GrokLedgerTurn {
  /** The ledger's own turn end; cross-checks the turn-number mapping. */
  endedAt: number | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

interface GrokLedger {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  calls: number;
  turns: number;
  costUsd: number | null;
  /** Keyed by the ledger's `turnNumber` (the event's `turn_number` + 1). */
  byTurn: Map<number, GrokLedgerTurn>;
}

interface GrokState {
  order: string[];
  turns: Map<string, GrokTurn>;
  openTurnKey: string | null;
  /** Phase currently open, if any. */
  phase: string | null;
  phaseStartedAt: number | null;
  /** Newest event timestamp; an open turn's span ends here. */
  lastEventAt: number;
  changeAt: number;
  /** `usage.json` is rewritten in place, so it is re-read when its mtime moves. */
  ledgerMtimeMs: number;
  ledger: GrokLedger | null;
}

const grokStates = new Map<string, GrokState>();

/** Whole non-negative counts; anything else reads as 0. */
function countOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The ledger exactly as Grok writes it. Its `inputTokens` is the **full prompt**
 * — the same struct the ACP `turn_completed` carries, with the cache buckets
 * already inside it. Every real `usage.json` on this machine (321/321) satisfies
 * `totalTokens = inputTokens + outputTokens`; only Grok's *headless* projector
 * subtracts the cache, and this file is not that. Normalizing here keeps the hit
 * rate's numerator and denominator on the same definition as every other
 * provider.
 */
function grokFreshInput(entry: Record<string, unknown>): number {
  const prompt = countOrZero(entry.inputTokens);
  return Math.max(0, prompt - countOrZero(entry.cachedReadTokens) - countOrZero(entry.cacheCreationTokens));
}

function readGrokLedger(path: string): GrokLedger | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = raw as Record<string, unknown>;
  const session = root.session as Record<string, unknown> | undefined;
  if (!session) return null;

  const byTurn = new Map<number, GrokLedgerTurn>();
  if (Array.isArray(root.turns)) {
    for (const entry of root.turns) {
      const turn = entry as Record<string, unknown>;
      const turnNumber = optionalNumber(turn.turnNumber);
      if (turnNumber === null) continue;
      byTurn.set(turnNumber, {
        endedAt: parseTime(turn.endedAt),
        input: grokFreshInput(turn),
        cacheRead: countOrZero(turn.cachedReadTokens),
        cacheWrite: countOrZero(turn.cacheCreationTokens),
        output: countOrZero(turn.outputTokens),
        reasoning: countOrZero(turn.reasoningTokens),
      });
    }
  }
  // `costUsdTicks` is 10^10 ticks per USD (Grok's own sessions doc).
  const ticks = countOrZero(session.costUsdTicks);
  return {
    input: grokFreshInput(session),
    cacheRead: countOrZero(session.cachedReadTokens),
    cacheWrite: countOrZero(session.cacheCreationTokens),
    output: countOrZero(session.outputTokens),
    reasoning: countOrZero(session.reasoningTokens),
    calls: countOrZero(session.modelCalls),
    turns: countOrZero(session.turnCount),
    costUsd: ticks > 0 ? ticks / 1e10 : null,
    byTurn,
  };
}

function grokClosePhase(state: GrokState, turn: GrokTurn | undefined, at: number): void {
  const phase = state.phase;
  const startedAt = state.phaseStartedAt;
  state.phase = null;
  state.phaseStartedAt = null;
  if (!turn || phase === null || startedAt === null || at <= startedAt) return;
  if (phase === GROK_THINK_PHASE) turn.think.push([startedAt, at]);
  else if (phase === GROK_OUT_PHASE) turn.out.push([startedAt, at]);
  else if (phase === GROK_TOOL_PHASE) turn.tool.push([startedAt, at]);
}

/**
 * The ledger numbers turns from 1 while the event stream numbers them from 0,
 * so `turnNumber = turn_number + 1`. The ledger also stores the turn's own end
 * time, so a numbering change on Grok's side degrades to "no tokens" instead of
 * silently attaching one turn's tokens to another.
 */
function grokLedgerTurn(state: GrokState, turn: GrokTurn): GrokLedgerTurn | undefined {
  const ledger = state.ledger;
  if (!ledger || turn.turnNumber === null) return undefined;
  const entry = ledger.byTurn.get(turn.turnNumber + 1);
  if (!entry) return undefined;
  if (
    entry.endedAt !== null &&
    turn.endedAt !== null &&
    Math.abs(entry.endedAt - turn.endedAt) > 5_000
  ) {
    return undefined;
  }
  return entry;
}

interface GrokBucket {
  speed: TurnSpeedMetrics;
  toolMs: number;
  /** A ledger row exists, so this turn's tokens are known. */
  recorded: boolean;
  /** Reasoning tokens exist but nothing streamed a thinking window. */
  untimedReasoning: boolean;
}

function grokTurnBucket(
  turn: GrokTurn,
  ledgerTurn: GrokLedgerTurn | undefined,
  openEnd: number,
): GrokBucket | null {
  const end = turn.endedAt ?? openEnd;
  const span = Math.max(0, end - turn.startedAt);
  if (span <= 0) return null;
  const thinkMs = unionMs(turn.think);
  const outWindowMs = unionMs(turn.out);
  const toolMs = unionMs(turn.tool);
  const decodeMs = thinkMs + outWindowMs;
  // Same definition as dsh: tool execution sits outside the model window, and
  // everything else inside the turn is the wait for a model's first token.
  const ttftMs = Math.max(0, span - decodeMs - toolMs);
  const hasThinking = turn.think.length > 0;
  const output = ledgerTurn?.output ?? 0;
  const recorded = ledgerTurn !== undefined;
  const untimedReasoning = (ledgerTurn?.reasoning ?? 0) > 0 && thinkMs < MIN_SAMPLE_MS;
  return {
    toolMs,
    recorded,
    untimedReasoning,
    speed: {
      turn: turn.turnNumber,
      output,
      ttftMs,
      decodeMs,
      samples: Math.max(1, turn.loops),
      tokensPerSecond:
        recorded && !untimedReasoning && output > 0 && decodeMs >= MIN_SAMPLE_MS
          ? output / (decodeMs / 1000)
          : null,
      // Unknown thinking must not print as "0.0s thinking".
      thinkMs: hasThinking ? thinkMs : null,
      outMs: hasThinking ? outWindowMs : null,
      modelMs: ttftMs + decodeMs,
    },
  };
}

function grokSpeeds(state: GrokState): { speed: SpeedMetrics | null; turnSpeed: TurnSpeedMetrics | null } {
  const buckets: GrokBucket[] = [];
  for (const key of state.order) {
    const turn = state.turns.get(key);
    if (!turn) continue;
    const bucket = grokTurnBucket(turn, grokLedgerTurn(state, turn), state.lastEventAt);
    if (bucket) buckets.push(bucket);
  }
  if (buckets.length === 0) return { speed: null, turnSpeed: null };
  // The newest turn supplies 本轮 even before its ledger row lands.
  const turnSpeed = buckets[buckets.length - 1].speed;
  // The rate's numerator and denominator have to cover the same turns, and the
  // ledger only holds settled turns, so anything unrecorded (the turn running
  // right now, or one the CLI never billed) stays out of `speed`.
  const recorded = buckets.filter((bucket) => bucket.recorded);
  if (recorded.length === 0) return { speed: null, turnSpeed };

  let output = 0;
  let ttftMs = 0;
  let decodeMs = 0;
  let thinkMs = 0;
  let toolMs = 0;
  let samples = 0;
  let thinkSamples = 0;
  let untimedReasoning = false;
  for (const bucket of recorded) {
    output += bucket.speed.output;
    ttftMs += bucket.speed.ttftMs;
    decodeMs += bucket.speed.decodeMs;
    toolMs += bucket.toolMs;
    samples += bucket.speed.samples;
    if (bucket.speed.thinkMs !== null) {
      thinkMs += bucket.speed.thinkMs;
      thinkSamples += 1;
    }
    if (bucket.untimedReasoning) untimedReasoning = true;
  }
  return {
    turnSpeed,
    speed: {
      output,
      ttftMs,
      decodeMs,
      samples,
      tokensPerSecond:
        !untimedReasoning && output > 0 && decodeMs >= MIN_SAMPLE_MS
          ? output / (decodeMs / 1000)
          : null,
      thinkMs: thinkSamples > 0 && !untimedReasoning ? thinkMs : null,
      // Output is the decode window minus thinking, so 生成 = 思考 + 输出 closes.
      outMs: thinkSamples > 0 && !untimedReasoning ? Math.max(0, decodeMs - thinkMs) : null,
      turns: recorded.length,
      steps: state.ledger?.calls ?? samples,
      modelMs: ttftMs + decodeMs,
      toolMs,
      ttftAvgMs: samples > 0 ? ttftMs / samples : null,
    },
  };
}

function grokSnapshot(dir: string, now: number): UsageSnapshot {
  const eventsPath = join(dir, "events.jsonl");
  let state = grokStates.get(dir);
  if (!state) {
    state = {
      order: [],
      turns: new Map(),
      openTurnKey: null,
      phase: null,
      phaseStartedAt: null,
      lastEventAt: 0,
      changeAt: now,
      ledgerMtimeMs: -1,
      ledger: null,
    };
    grokStates.set(dir, state);
  }
  const lines = readAppendedJsonl(eventsPath);
  if (lines.length > 0) state.changeAt = now;

  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    const type = typeof line.type === "string" ? line.type : "";
    const at = parseTime(line.ts);
    if (at === null) continue;
    if (at > state.lastEventAt) state.lastEventAt = at;

    if (type === "turn_started") {
      // A turn that never got its `turn_ended` (crash, kill) ends where the
      // next one begins.
      const previous = state.openTurnKey !== null ? state.turns.get(state.openTurnKey) : undefined;
      if (previous) {
        grokClosePhase(state, previous, at);
        previous.endedAt = at;
      }
      const turnNumber = optionalNumber(line.turn_number);
      const key = turnNumber !== null ? `n${turnNumber}` : `t${state.order.length + 1}`;
      if (!state.turns.has(key)) {
        state.turns.set(key, {
          turnNumber,
          startedAt: at,
          endedAt: null,
          loops: 0,
          think: [],
          out: [],
          tool: [],
        });
        state.order.push(key);
      }
      state.openTurnKey = key;
      continue;
    }

    const turn = state.openTurnKey !== null ? state.turns.get(state.openTurnKey) : undefined;
    if (!turn) continue;

    if (type === "loop_started") {
      turn.loops += 1;
      continue;
    }
    if (type === "phase_changed") {
      const phase = typeof line.phase === "string" ? line.phase : null;
      if (phase === state.phase) continue;
      grokClosePhase(state, turn, at);
      state.phase = phase;
      state.phaseStartedAt = at;
      continue;
    }
    if (type === "turn_ended") {
      grokClosePhase(state, turn, at);
      turn.endedAt = at;
      state.openTurnKey = null;
    }
  }

  // The ledger is rewritten in place, so a changed mtime means a new snapshot.
  const ledgerPath = join(dir, "usage.json");
  const ledgerMtime = newestMtime(ledgerPath);
  if (ledgerMtime !== state.ledgerMtimeMs) {
    state.ledgerMtimeMs = ledgerMtime;
    state.ledger = readGrokLedger(ledgerPath);
  }
  const ledger = state.ledger;

  const speeds = grokSpeeds(state);
  // Fallback row when no turn has settled tokens yet: every measured turn span
  // is model-side wall clock once tool execution is taken out.
  let totalMs = 0;
  const allTool: PhaseWindow[] = [];
  for (const key of state.order) {
    const turn = state.turns.get(key);
    if (!turn) continue;
    totalMs += Math.max(0, (turn.endedAt ?? state.lastEventAt) - turn.startedAt);
    allTool.push(...turn.tool);
  }
  const sessionToolMs = unionMs(allTool);
  // Covers EVERY turn, including the ones `speed` left out (no ledger row): it is
  // what the client shows when `speed` is null.
  const timing: TimingMetrics = {
    totalMs,
    toolMs: sessionToolMs,
    requestMs: Math.max(0, totalMs - sessionToolMs),
    otherMs: 0,
  };

  // `last` is the newest turn the ledger has settled tokens for.
  let last: StepMetrics | null = null;
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const turn = state.turns.get(state.order[index]);
    if (!turn) continue;
    const entry = grokLedgerTurn(state, turn);
    if (!entry) continue;
    last = {
      turn: turn.turnNumber,
      step: null,
      output: entry.output,
      reasoning: entry.reasoning,
      input: entry.input,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      stepMs: null,
      tokensPerSecond: null,
      hitPct: hitRate(entry.input, entry.cacheRead, entry.cacheWrite),
      endedAt: turn.endedAt,
    };
    break;
  }
  // The pill prefers the newest turn's rate; a turn whose ledger row has not
  // landed yet falls back to the session's measured rate.
  if (last) {
    last.tokensPerSecond =
      speeds.turnSpeed?.tokensPerSecond ?? speeds.speed?.tokensPerSecond ?? null;
  }

  return {
    source: "grok-session",
    sourceAgeMs: Math.max(0, now - state.changeAt),
    inFlight: state.openTurnKey !== null,
    last,
    totals: ledger
      ? makeTotals(ledger.input, ledger.cacheRead, ledger.cacheWrite, ledger.output, ledger.reasoning)
      : null,
    context: null,
    cost: ledger?.costUsd != null && ledger.costUsd > 0
      ? { value: ledger.costUsd, currency: "USD" }
      : null,
    timing,
    turnSpeed: speeds.turnSpeed,
    speed: speeds.speed,
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

/* ────────────────────────────── antigravity ────────────────────────────── */

/**
 * `antigravity` (native `agy acp`) and legacy `antigravity-cli` (`agy-acp`)
 * store per-conversation SQLite DBs in `~/.gemini/antigravity-cli/conversations/<conv>.db`.
 * `gen_metadata` carries per-call token stats (`input_tokens` already uncached,
 * `output_tokens` already including `thinking_output_tokens`, `cache_write_tokens`,
 * `cache_read_tokens`), `time_to_first_token` (field 11), and `streaming_duration`
 * (field 12); `steps` carries per-step timestamps, `thinking_duration` (on
 * `step_type = 15`), and `step_type = 132` tool execution intervals.
 */
function agyContextWindow(gen: { contextWindowSize?: number; modelSlug?: string }): number | null {
  if (gen.contextWindowSize && gen.contextWindowSize > 0) return gen.contextWindowSize;
  const slug = gen.modelSlug?.toLowerCase() ?? "";
  if (slug.includes("gemini")) return 1_048_576;
  if (slug.includes("claude")) return 200_000;
  if (slug.includes("gpt-")) return 128_000;
  return null;
}

function agySnapshot(agentId: string, sessionId: string, home: string, now: number): UsageSnapshot | null {
  const raw = readAgyUsage(sessionId, home, now);
  if (!raw?.last) return null;
  const gen = raw.last;
  const input = gen.inputTokens;
  const cacheRead = gen.cachedTokens;
  const cacheWrite = gen.cacheWriteTokens;
  const output = gen.outputTokens;
  const window = agyContextWindow(gen);
  const tps =
    raw.lastTokensPerSecond ??
    raw.turnSpeed?.tokensPerSecond ??
    raw.speed?.tokensPerSecond ??
    liveSpeed(agentId, raw.output, now);
  return {
    source: "agy-db",
    sourceAgeMs: raw.sourceAgeMs,
    inFlight: raw.inFlight, // withContextFallback overrides when Paseo passes `running`
    last: {
      turn: raw.lastTurn,
      step: raw.lastStep,
      output,
      reasoning: gen.thoughtTokens,
      input,
      cacheRead,
      cacheWrite,
      stepMs: raw.lastStepMs,
      tokensPerSecond: tps,
      hitPct: hitRate(input, cacheRead, cacheWrite),
      endedAt: raw.lastEndedAt ?? raw.endedAt,
    },
    totals: {
      ...makeTotals(raw.input, raw.cacheRead, raw.cacheWrite, raw.output, raw.reasoning),
      turns: raw.turns,
      steps: raw.calls,
    },
    context: window !== null ? { used: gen.totalInputTokens, window, pressure: null } : null,
    cost: null,
    timing: raw.timing,
    ...(raw.turnSpeed ? { turnSpeed: raw.turnSpeed } : {}),
    ...(raw.speed ? { speed: raw.speed } : {}),
  };
}

/* ────────────────────────────── droid ────────────────────────────── */

/**
 * Factory's droid keeps `~/.factory/sessions/<encoded-cwd>/<sid>.jsonl` — one
 * `type:"message"` record per committed message, `content[].type` carrying
 * tool_use/tool_result/text/thinking — plus a `<sid>.settings.json` sibling it
 * rewrites after every call. Token counts live only in the settings file
 * (`tokenUsage` = this session, `inclusiveTokenUsage` = child sessions folded
 * in, `lastCallTokenUsage` = the latest call); wall-clock phases live only in
 * the JSONL timestamps. droid never sends `usage_update`, so the Paseo
 * fallback would see nothing at all.
 */
interface DroidState {
  /** Wall of the last committed model call; paired with `lastCallTokenUsage`. */
  stepMs: number | null;
  endedAt: number | null;
  prevAt: number | null;
  /**
   * Turns still open, keyed by the record `id` of the message that opened them
   * — that is what `agent_turn_outcome.turnId` carries. One file interleaves
   * several turns (prompt turns and `task-completion:*` wake-ups), so a single
   * boolean would let an unrelated outcome close the wrong turn and drop a
   * late tool_result's window.
   */
  openTurns: Set<string>;
  /** Open turns whose last event is a prompt/tool_result still awaiting a call. */
  awaiting: Set<string>;
  /** Record id -> owning turn id; children resolve through `parentId`. */
  turnOf: Map<string, string>;
  timing: TimingMetrics;
  changeAt: number;
}

const droidStates = new Map<string, DroidState>();

interface DroidTokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

function droidTokenUsage(raw: unknown): DroidTokenUsage | null {
  if (raw === null || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  return {
    input: asNumber(usage.inputTokens),
    cacheRead: asNumber(usage.cacheReadTokens),
    cacheWrite: asNumber(usage.cacheCreationTokens),
    output: asNumber(usage.outputTokens),
    reasoning: asNumber(usage.thinkingTokens),
  };
}

/** The settings file is small and rewritten in place; the `.bak` covers a torn read. */
function readDroidSettings(jsonlPath: string): {
  session: DroidTokenUsage | null;
  lastCall: DroidTokenUsage | null;
} {
  const base = jsonlPath.endsWith(".jsonl") ? jsonlPath.slice(0, -".jsonl".length) : jsonlPath;
  for (const candidate of [`${base}.settings.json`, `${base}.settings.json.bak`]) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    return {
      session: droidTokenUsage(parsed.inclusiveTokenUsage) ?? droidTokenUsage(parsed.tokenUsage),
      lastCall: droidTokenUsage(parsed.lastCallTokenUsage),
    };
  }
  return { session: null, lastCall: null };
}

function droidContentKinds(message: Record<string, unknown>): Set<string> {
  const kinds = new Set<string>();
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part !== null && typeof part === "object") {
        const type = (part as { type?: unknown }).type;
        if (typeof type === "string") kinds.add(type);
      }
    }
  }
  return kinds;
}

/**
 * A real turn-opening prompt vs the bookkeeping user records droid interleaves.
 * Anything carrying `interactionMode` truly opens a turn — user prompts,
 * `# Task Tool Invocation` spawns, and `task-completion:*` wake-ups (which are
 * `llm_only` but still precede a real model call). Records without it are
 * bookkeeping: hook firings (`hookEventName`, empty content), `llm_only`
 * reminders, `user_only`/`both` error notices (BYOK errors, timeouts), and
 * `<system-reminder>` / `<chat-history-summary>` injections whose text starts
 * with "<".
 */
function isDroidPrompt(message: Record<string, unknown>): boolean {
  if (typeof message.hookEventName === "string") return false;
  if (typeof message.interactionMode === "string") return true;
  if (message.visibility !== undefined) return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const block = part as { type?: unknown; text?: unknown };
    return (
      block.type === "text" &&
      typeof block.text === "string" &&
      !block.text.trimStart().startsWith("<")
    );
  });
}

/** Resolve a record's turn: its parent's, or the only open turn as fallback. */
function droidTurnFor(state: DroidState, parentTurn: string | undefined): string | undefined {
  if (parentTurn !== undefined) return parentTurn;
  if (state.openTurns.size === 1) return state.openTurns.values().next().value;
  return undefined;
}

function droidSnapshot(path: string, now: number): UsageSnapshot {
  let state = droidStates.get(path);
  if (!state) {
    state = {
      stepMs: null,
      endedAt: null,
      prevAt: null,
      openTurns: new Set(),
      awaiting: new Set(),
      turnOf: new Map(),
      timing: emptyTiming(),
      changeAt: now,
    };
    droidStates.set(path, state);
  }
  const lines = readAppendedJsonl(path);
  if (lines.length > 0) state.changeAt = now;

  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    const at = parseTime(line.timestamp);

    // todo_state / compaction_state / session_start are bookkeeping and carry
    // no turn identity. The outcome closes exactly one turn — identified by the
    // record id of the message that opened it.
    if (line.type === "agent_turn_outcome") {
      const turnId = typeof line.turnId === "string" ? line.turnId : null;
      if (turnId !== null) {
        state.openTurns.delete(turnId);
        state.awaiting.delete(turnId);
      } else if (state.openTurns.size <= 1) {
        state.openTurns.clear();
        state.awaiting.clear();
      }
      continue;
    }
    if (line.type !== "message") continue;

    const message = line.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const recordId = typeof line.id === "string" ? line.id : null;
    const parentTurn =
      typeof line.parentId === "string" ? state.turnOf.get(line.parentId) : undefined;
    // Bookkeeping records (reminders, hooks) can still be parents; inherit the
    // turn so their children resolve.
    if (recordId !== null && parentTurn !== undefined) state.turnOf.set(recordId, parentTurn);
    const turn = droidTurnFor(state, parentTurn);
    const turnOpen = turn !== undefined && state.openTurns.has(turn);

    if (message.role === "assistant") {
      const endedAt = at;
      state.stepMs =
        endedAt !== null && state.prevAt !== null ? Math.max(0, endedAt - state.prevAt) : null;
      state.endedAt = endedAt;
      if (turnOpen) addGap(state.timing, state.prevAt, endedAt, "request");
      if (turn !== undefined) state.awaiting.delete(turn);
      if (endedAt !== null) state.prevAt = endedAt;
      continue;
    }

    if (message.role !== "user") continue;
    if (droidContentKinds(message).has("tool_result")) {
      // The gap since the assistant call that requested the tool is tool time —
      // but only while its own turn is still open; an outcome for another turn
      // interleaved in the same file must not steal it.
      if (turnOpen && state.prevAt !== null && at !== null) {
        const gap = at - state.prevAt;
        if (gap > 0) {
          state.timing.totalMs += gap;
          state.timing.toolMs += gap;
        }
      }
      if (turn !== undefined) state.awaiting.add(turn);
      if (at !== null) state.prevAt = at;
      continue;
    }
    if (!isDroidPrompt(message)) continue;
    // The outcome's turnId is this record's own id.
    const turnId = recordId ?? `prompt-${at ?? 0}:${state.openTurns.size}`;
    state.openTurns.add(turnId);
    state.awaiting.add(turnId);
    state.turnOf.set(turnId, turnId);
    if (recordId !== null) state.turnOf.set(recordId, turnId);
    if (at !== null) state.prevAt = at;
  }

  const settings = readDroidSettings(path);
  const call = settings.lastCall;
  const hasCall =
    call !== null && (call.input > 0 || call.cacheRead > 0 || call.cacheWrite > 0 || call.output > 0);
  const totals = settings.session;

  return {
    source: "droid-session",
    sourceAgeMs: Math.max(0, now - state.changeAt),
    inFlight: state.awaiting.size > 0,
    last: hasCall
      ? {
          turn: null,
          step: null,
          output: call.output,
          reasoning: call.reasoning,
          input: call.input,
          cacheRead: call.cacheRead,
          cacheWrite: call.cacheWrite,
          stepMs: state.stepMs,
          tokensPerSecond: stepSpeed(call.output, state.stepMs),
          hitPct: hitRate(call.input, call.cacheRead, call.cacheWrite),
          endedAt: state.endedAt,
        }
      : null,
    totals:
      totals !== null && (totals.output > 0 || totals.input > 0 || totals.cacheRead > 0)
        ? makeTotals(
            totals.input,
            totals.cacheRead,
            totals.cacheWrite,
            totals.output,
            totals.reasoning,
          )
        : null,
    context: null,
    // droid bills in factoryCredits, not a currency this panel reports.
    cost: null,
    timing: finalizeTiming(state.timing),
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
    cost: cost !== null && cost > 0 ? { value: cost, currency: "USD" } : null,
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
    if (cost !== null && cost > 0) snapshot.cost = { value: cost, currency: "USD" };
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

  if (input.provider === "dsh" && input.sessionId) {
    const snapshot = dshSnapshot(input.sessionId, home);
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
    // Grok is a configured ACP provider (`grok agent stdio`); its CLI keeps one
    // directory per session under a per-cwd name.
    if (input.provider === "grok") {
      const sessionId = input.sessionId;
      const dir = cachedSessionFile(`grok:${sessionId}`, () => findGrokDir(home, sessionId));
      if (dir) return withContextFallback(grokSnapshot(dir, now), input);
    }
    if (input.provider === "devin") {
      const snapshot = devinSnapshot(input.sessionId, home, now);
      if (snapshot) return withContextFallback(snapshot, input);
    }
    // `antigravity` (native `agy acp`) and legacy `antigravity-cli` (`agy-acp`)
    // store per-conversation SQLite DBs under ~/.gemini/antigravity-cli/conversations/
    if (input.provider === "antigravity" || input.provider === "antigravity-cli") {
      const snapshot = agySnapshot(agentId, input.sessionId, home, now);
      if (snapshot) return withContextFallback(snapshot, input);
    }
    // Factory's droid CLI — the builtin provider is `factory-droid` (and the
    // `factory-droid-rewind` variant), custom gateways arrive as `droid-<name>`
    // like droid-magpie — writes ~/.factory/sessions/<encoded-cwd>/<sid>.jsonl.
    if (input.provider !== null && /^(?:factory-)?droid(?:-|$)/.test(input.provider)) {
      const sessionId = input.sessionId;
      const path = cachedSessionFile(`droid:${sessionId}`, () =>
        findSessionFile([join(home, ".factory", "sessions")], `${sessionId}.jsonl`),
      );
      if (path) return withContextFallback(droidSnapshot(path, now), input);
    }
  }

  const fallback = passthroughSnapshot(agentId, input, now);
  return fallback ? withContextFallback(fallback, input) : null;
}

function findCodexFile(home: string, sessionId: string): string | null {
  // Codex moves a finished thread's rollout to `archived_sessions`, so a session
  // that was live a minute ago can disappear from the first root.
  for (const dir of ["sessions", "archived_sessions"]) {
    const root = join(home, ".codex", dir);
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    const match = entries.find((entry) => entry.endsWith(".jsonl") && entry.includes(sessionId));
    if (match) return join(root, match);
  }
  return null;
}

/**
 * `~/.grok/sessions/<url-encoded cwd>/<sessionId>/`. The plugin is not told the
 * agent's cwd, so the one shallow level of path-encoded directories is scanned;
 * the result is cached by `collectUsage`, so this runs once per session.
 */
function findGrokDir(home: string, sessionId: string): string | null {
  const root = join(home, ".grok", "sessions");
  if (!existsSync(root)) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const dir = join(root, entry, sessionId);
    if (existsSync(join(dir, "events.jsonl")) || existsSync(join(dir, "usage.json"))) return dir;
  }
  return null;
}

export function sessionFileAge(path: string): number {
  const mtime = newestMtime(path);
  return mtime > 0 ? Math.max(0, Date.now() - mtime) : 0;
}
