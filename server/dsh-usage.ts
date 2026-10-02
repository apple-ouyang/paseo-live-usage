/**
 * dsh (DeepSeek Harness) usage reader.
 *
 * Why this exists: dsh is an ACP provider, and its ACP bridge only forwards
 * `used`/`size` in `usage_update`. Input/output/cache token counts never reach
 * Paseo, so `agent.lastUsage` has no cache data for dsh sessions. dsh does record
 * every model call with full buckets in its own session store, so this plugin
 * reads that store directly from the daemon (server code runs with the daemon
 * user's filesystem access).
 *
 * Two sources, both under `~/.dsh`:
 *   - `storages/session_projcache/sessions/<id>.json` — plain JSON projection with
 *     session totals and the latest step buckets (cheap, rewritten in place).
 *   - `sessions/*\/<id>/session.v<N>.jsonl.zstd` — append-only event log (v3 before
 *     dsh 0.1.7-rc.2, v4 from 2026-09-26 on; the highest version present wins). It is a
 *     concatenation of independent zstd frames, so we decode frame by frame and
 *     only decode frames appended since the previous poll. Every event carries
 *     `seq`/`time`, and the per-token stream is packed into the settlement event,
 *     so `assistant/message.data.stream` yields the first and last chunk instants.
 *     Those give dsh's own split of a call: `step/start` -> first chunk is TTFT,
 *     first chunk -> message is the decode window the TPS badge divides by, and
 *     tool execution sits outside both. The same numbers aggregate per turn and
 *     across the session — a turn with a tool loop sums its calls, not one call.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

const MIN_SAMPLE_MS = 250;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export interface StepUsage {
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
  endedAt: number;
}

export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  hitPct: number | null;
}

export interface UsageContext {
  used: number;
  window: number;
  pressure: number | null;
}

export interface DshTiming {
  totalMs: number;
  toolMs: number;
  requestMs: number;
  otherMs: number;
}

/**
 * dsh's own decode accounting, mirrored from `dsh-tui`'s trajectory aggregate:
 * a call streams a first chunk, then decodes until the message lands. Tool
 * waits sit outside both spans, so they never slow the rate down.
 */
export interface DecodeSpeed {
  /** Σ output tokens over the calls. */
  output: number;
  /** Σ (first chunk − step/start) — the wait for the first token. */
  ttftMs: number;
  /** Σ (message landed − first chunk) — the decode window. */
  decodeMs: number;
  /** Calls that actually streamed, i.e. contributed a TTFT and a decode span. */
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

/** One turn's decode accounting; `modelMs` is `ttftMs + decodeMs`. */
export interface TurnSpeed extends DecodeSpeed {
  turn: number | null;
  /** ttftMs + decodeMs. */
  modelMs: number;
}

/** Whole-session accounting for the panel's "会话统计" rows. */
export interface SpeedTotals extends DecodeSpeed {
  turns: number;
  steps: number;
  /** ttftMs + decodeMs: the model-side wall clock, tool waits excluded. */
  modelMs: number;
  /** Tool wall clock, parallel batches counted once. */
  toolMs: number;
  /** ttftMs ÷ samples — dsh's "首 token 平均 (TTFT)". */
  ttftAvgMs: number | null;
}

export interface DshSnapshot {
  observedAt: number;
  sourceAgeMs: number;
  inFlight: boolean;
  last: StepUsage | null;
  totals: UsageTotals | null;
  context: UsageContext | null;
  timing: DshTiming;
  /** Newest turn's decode accounting. */
  turnSpeed: TurnSpeed | null;
  /** Whole-session decode accounting. */
  speed: SpeedTotals | null;
}

interface RawStep {
  seq: number;
  turn: number | null;
  step: number | null;
  output: number;
  reasoning: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  at: number;
}

interface LogState {
  size: number;
  mtimeMs: number;
  offset: number;
  /**
   * Undelivered tail bytes across frame boundaries. A zstd frame can end
   * mid-line and mid-UTF-8-character, so this stays a Buffer and only complete
   * lines are decoded — decoding each frame to a string would bake U+FFFD into
   * the pending tail and lose the line.
   */
  pending: Buffer;
  steps: RawStep[];
  /**
   * `turn:step` -> first and last streamed chunk timestamps, plus the reasoning
   * window. dsh packs the per-token stream into the settlement event, so this is
   * the only place the first-token instant and the thinking span survive (see
   * `feedStream`).
   */
  chunks: Map<string, { first: number; last: number; think: [number, number] | null }>;
  /**
   * `turn:step` -> the `step/start` instant plus its turn. This is dsh's timing
   * slot: a call can stream and settle without a usage block, and its TTFT and
   * decode still belong to the step.
   */
  starts: Map<string, { at: number; turn: number | null }>;
  open: Set<string>;
  turnCount: number;
  stepCount: number;
  /** turn/start keyed by turn number, for total active time. */
  turnStarts: Map<string, number>;
  /** tool/call keyed by callId, for tool wall-clock. */
  toolStarts: Map<string, number>;
  toolIntervals: Array<[number, number]>;
  totalMs: number;
  requestMs: number;
}

const logStates = new Map<string, LogState>();

function zstdDecode(buf: Buffer): Buffer {
  const fn = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer })
    .zstdDecompressSync;
  if (!fn) throw new Error("zstd decompression is unavailable in the daemon runtime");
  return fn(buf);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

function stepKey(turn: unknown, step: unknown): string {
  return `${String(turn)}:${String(step)}`;
}

/**
 * dsh names the log after its storage-format version: 0.1.7-rc.2 (2026-09-26)
 * switched to `session.v4.jsonl.zstd` while older sessions stay on v3, and the
 * event schema did not change. Take the highest version present instead of a
 * hardcoded name, so the next bump cannot silently drop the log again.
 */
function findLogPath(home: string, sessionId: string): string | null {
  const root = join(home, ".dsh", "sessions");
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry, sessionId);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    let best: { name: string; version: number } | null = null;
    for (const file of files) {
      const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(file);
      if (!match) continue;
      const version = Number(match[1]);
      if (best === null || version > best.version) best = { name: file, version };
    }
    if (best !== null) return join(dir, best.name);
  }
  return null;
}

function magicPositions(buf: Buffer, from: number): number[] {
  const positions: number[] = [];
  let index = from;
  for (;;) {
    index = buf.indexOf(ZSTD_MAGIC, index);
    if (index < 0) return positions;
    positions.push(index);
    index += 1;
  }
}

/**
 * First (or last) instant a compact stream record covers. Content records carry
 * `time0` plus per-delta offsets in `dt`; structural records (block-start,
 * block-end, usage, finish) carry a plain `time`.
 */
function recordTime(record: unknown, edge: "first" | "last"): number | null {
  if (record === null || typeof record !== "object") return null;
  const row = record as { time?: unknown; time0?: unknown; dt?: unknown };
  if (typeof row.time0 === "number") {
    if (edge === "first") return row.time0;
    // Sum every delta, negatives included: that is what dsh's own
    // `expandAssistantStream` does, so the last-chunk instant matches exactly.
    const deltas = Array.isArray(row.dt) ? row.dt : [];
    let offset = 0;
    for (const delta of deltas) {
      if (typeof delta === "number" && Number.isFinite(delta)) offset += delta;
    }
    return row.time0 + offset;
  }
  return typeof row.time === "number" ? row.time : null;
}

/** Whether a stream record belongs to the reasoning (thinking) window. */
function isReasoningRecord(recordType: unknown): boolean {
  return recordType === "reasoning-chunks" || recordType === "reasoning-delta";
}

/**
 * Fold one step's chunk timestamps. dsh first-wins on the first chunk, so a
 * retried attempt that streamed before the committed one still anchors TTFT to
 * the earliest observable output, and always keeps the latest chunk.
 */
function feedChunks(state: LogState, key: string, first: number, last: number): void {
  const slot = state.chunks.get(key);
  if (slot === undefined) state.chunks.set(key, { first, last, think: null });
  else slot.last = last;
}

/**
 * Widen a step's reasoning window. Deliberately separate from `feedChunks`: a
 * reasoning record's end is NOT the end of the step (text, tool-call arguments
 * and the `finish` record land later), so folding it as `last` would cut the
 * decode window short.
 */
function foldThink(state: LogState, key: string, first: number, last: number): void {
  const slot = state.chunks.get(key);
  if (slot === undefined) return;
  const span = slot.think;
  slot.think = span === null ? [first, last] : [Math.min(span[0], first), Math.max(span[1], last)];
}

/** Fold a settlement event's embedded stream into the step's chunk slots. */
function feedStream(state: LogState, key: string, stream: unknown): void {
  if (!Array.isArray(stream) || stream.length === 0) return;
  const first = recordTime(stream[0], "first");
  if (first === null) return;
  feedChunks(state, key, first, recordTime(stream[stream.length - 1], "last") ?? first);
  // Reasoning records are the only way to separate thinking from the rest of the
  // decode window, which is what lets the panel report thinking on its own.
  for (const record of stream) {
    if (!isReasoningRecord((record as { type?: unknown } | null)?.type)) continue;
    const start = recordTime(record, "first");
    const end = recordTime(record, "last");
    if (start === null || end === null) continue;
    foldThink(state, key, start, end);
  }
}

function consumeLine(state: LogState, line: string): void {
  let event: { type?: unknown; seq?: unknown; time?: unknown; data?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return;
  }
  const type = typeof event.type === "string" ? event.type : "";
  const time = typeof event.time === "number" ? event.time : 0;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const seq = typeof event.seq === "number" ? event.seq : 0;

  if (type === "turn/start") {
    state.turnStarts.set(String(data.turn), time);
    state.turnCount += 1;
    return;
  }

  if (type === "turn/end") {
    const startedAt = state.turnStarts.get(String(data.turn));
    if (startedAt !== undefined && time > startedAt) state.totalMs += time - startedAt;
    state.turnStarts.delete(String(data.turn));
    return;
  }

  if (type === "tool/call") {
    const callId = typeof data.callId === "string" ? data.callId : "";
    if (callId) state.toolStarts.set(callId, time);
    return;
  }

  if (type === "tool/result") {
    // tool/result carries no top-level callId; it is on message.source (or the block).
    const message = data.message as Record<string, unknown> | undefined;
    const source = message?.source as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? (message?.content as unknown[]) : [];
    const firstBlock = content[0] as Record<string, unknown> | undefined;
    const callId =
      typeof source?.callId === "string"
        ? source.callId
        : typeof firstBlock?.toolCallId === "string"
          ? firstBlock.toolCallId
          : "";
    const startedAt = state.toolStarts.get(callId);
    if (startedAt !== undefined && time > startedAt) state.toolIntervals.push([startedAt, time]);
    state.toolStarts.delete(callId);
    return;
  }

  if (type === "step/start") {
    const key = stepKey(data.turn, data.step);
    state.starts.set(key, {
      at: time,
      turn: typeof data.turn === "number" ? data.turn : null,
    });
    state.open.add(key);
    state.stepCount += 1;
    return;
  }

  // Stream timestamps arrive two ways, and both must fold into the same slots.
  // Pre-0.1.5 logs write one `assistant/chunk` event per delta; V3 logs replace
  // them with a compact record list embedded in the settlement event, and a
  // retried call settles through `assistant/attempt` instead of a message.
  if (type === "assistant/chunk") {
    const key = stepKey(data.turn, data.step);
    feedChunks(state, key, time, time);
    const chunkType = (data.chunk as { type?: unknown } | undefined)?.type;
    if (isReasoningRecord(chunkType)) foldThink(state, key, time, time);
    return;
  }
  if (type === "assistant/attempt") {
    feedStream(state, stepKey(data.turn, data.step), data.stream);
    return;
  }

  if (type !== "assistant/message") return;
  feedStream(state, stepKey(data.turn, data.step), data.stream);
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage) return;
  const key = stepKey(data.turn, data.step);
  const start = state.starts.get(key);
  if (start !== undefined && time > start.at) state.requestMs += time - start.at;
  state.open.delete(key);
  state.steps.push({
    seq,
    turn: typeof data.turn === "number" ? data.turn : null,
    step: typeof data.step === "number" ? data.step : null,
    output: asNumber(usage.outputTokens),
    reasoning: asNumber(usage.reasoningTokens),
    input: asNumber(usage.inputTokens),
    cacheRead: asNumber(usage.cacheReadTokens),
    cacheWrite: asNumber(usage.cacheWriteTokens),
    at: time,
  });
}

/** Decode frames appended since the previous poll; falls back to a clean re-read. */
function readLog(path: string): LogState {
  const stat = statSync(path);
  let state = logStates.get(path);
  if (!state || state.size > stat.size) {
    state = {
      size: 0,
      mtimeMs: 0,
      offset: 0,
      pending: Buffer.alloc(0),
      steps: [],
      chunks: new Map(),
      starts: new Map(),
      open: new Set(),
      turnCount: 0,
      stepCount: 0,
      turnStarts: new Map(),
      toolStarts: new Map(),
      toolIntervals: [],
      totalMs: 0,
      requestMs: 0,
    };
    logStates.set(path, state);
  }
  if (state.size === stat.size && state.mtimeMs === stat.mtimeMs) return state;

  const buf = readFileSync(path);
  if (buf.length === state.size) return state;

  const positions = magicPositions(buf, state.offset);
  if (positions.length === 0 || positions[0] !== state.offset) {
    // Unexpected layout (truncated/rotated): start over.
    state.offset = 0;
    state.pending = Buffer.alloc(0);
    state.steps = [];
    state.chunks = new Map();
    state.starts = new Map();
    state.open = new Set();
    state.turnCount = 0;
    state.stepCount = 0;
    state.turnStarts = new Map();
    state.toolStarts = new Map();
    state.toolIntervals = [];
    state.totalMs = 0;
    state.requestMs = 0;
    positions.length = 0;
    positions.push(...magicPositions(buf, 0));
  }

  let index = 0;
  while (index < positions.length) {
    const start = positions[index];
    let sliceEnd = start;
    let chunk: Buffer | null = null;
    for (let next = index + 1; next <= positions.length; next += 1) {
      sliceEnd = next < positions.length ? positions[next] : buf.length;
      try {
        chunk = zstdDecode(buf.subarray(start, sliceEnd));
        index = next;
        break;
      } catch {
        // A false magic inside compressed bytes, or an incomplete tail frame.
        // Widen the slice; if that runs past the end, wait for the next poll.
        chunk = null;
      }
    }
    if (chunk === null) break;

    state.pending = Buffer.concat([state.pending, chunk]);
    let newline = state.pending.indexOf(0x0a);
    while (newline >= 0) {
      consumeLine(state, state.pending.subarray(0, newline).toString("utf8"));
      state.pending = state.pending.subarray(newline + 1);
      newline = state.pending.indexOf(0x0a);
    }
    state.offset = sliceEnd;
  }

  state.size = buf.length;
  state.mtimeMs = stat.mtimeMs;
  return state;
}

function readProjection(
  home: string,
  sessionId: string,
): { totals: UsageTotals | null; context: UsageContext | null; mtimeMs: number | null } {
  const path = join(home, ".dsh", "storages", "session_projcache", "sessions", `${sessionId}.json`);
  if (!existsSync(path)) return { totals: null, context: null, mtimeMs: null };
  let rows: Record<string, { val?: unknown }>;
  try {
    rows = (JSON.parse(readFileSync(path, "utf8")) as { record?: { rows?: typeof rows } }).record
      ?.rows as typeof rows;
  } catch {
    return { totals: null, context: null, mtimeMs: null };
  }
  if (!rows) return { totals: null, context: null, mtimeMs: null };

  let totals: UsageTotals | null = null;
  const tokenUsage = rows.tokenUsage?.val as { totals?: Record<string, unknown> } | undefined;
  if (tokenUsage?.totals) {
    const input = asNumber(tokenUsage.totals.uncachedInputTokens);
    const cacheRead = asNumber(tokenUsage.totals.cacheReadTokens);
    const cacheWrite = asNumber(tokenUsage.totals.cacheWriteTokens);
    totals = {
      input,
      cacheRead,
      cacheWrite,
      output: asNumber(tokenUsage.totals.outputTokens),
      hitPct: percent(cacheRead, input + cacheRead + cacheWrite),
    };
  }

  let context: UsageContext | null = null;
  const pressure = rows.contextPressure?.val as Record<string, unknown> | undefined;
  if (pressure) {
    const window = asNumber(pressure.contextWindow);
    const used = asNumber(pressure.pressureTokens) || asNumber(pressure.surfaceTokens);
    if (window > 0) {
      context = { used, window, pressure: asNumber(pressure.pressureTokens) || null };
    }
  }

  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  return { totals, context, mtimeMs };
}

/** Union length of half-open intervals, so parallel tool batches are not double counted. */
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
  total += end - start;
  return total;
}

/** Highest-seq committed message per step, so retries do not double count. */
function committedSteps(state: LogState): RawStep[] {
  const byStep = new Map<string, RawStep>();
  for (const step of state.steps) {
    const key = stepKey(step.turn, step.step);
    const previous = byStep.get(key);
    if (!previous || step.seq >= previous.seq) byStep.set(key, step);
  }
  return [...byStep.values()];
}

/** `step/start` -> committed message wall clock; null when the start was never seen. */
function measuredStepMs(state: LogState, step: RawStep): number | null {
  const start = state.starts.get(stepKey(step.turn, step.step));
  return start !== undefined && step.at > start.at ? step.at - start.at : null;
}

function speed(output: number, decodeMs: number | null): number | null {
  return decodeMs !== null && decodeMs >= MIN_SAMPLE_MS ? output / (decodeMs / 1000) : null;
}

function lastStep(state: LogState): StepUsage | null {
  const raw = state.steps[state.steps.length - 1];
  if (!raw) return null;
  const stepMs = measuredStepMs(state, raw);
  return {
    turn: raw.turn,
    step: raw.step,
    output: raw.output,
    reasoning: raw.reasoning,
    input: raw.input,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    stepMs,
    tokensPerSecond: speed(raw.output, stepMs),
    hitPct: percent(raw.cacheRead, raw.input + raw.cacheRead + raw.cacheWrite),
    endedAt: raw.at,
  };
}

/**
 * dsh's decode accounting, per turn and for the whole session.
 *
 * A call's model time is `step/start` -> message landed. Inside it, the wait for
 * the first streamed chunk is TTFT and the rest is the decode window; tool waits
 * sit outside both, so they never slow the rate down. Calls that never streamed
 * (failed request, log predating chunk capture) contribute no TTFT and no decode
 * span — dsh's "no fabricated spans" rule — so they are skipped rather than
 * counted as a zero that would drag the average down. Output tokens still count
 * them, exactly as dsh's own totals do.
 */
function turnSpeeds(state: LogState): { last: TurnSpeed | null; speed: SpeedTotals | null } {
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      turn: number | null;
      output: number;
      ttftMs: number;
      decodeMs: number;
      samples: number;
      thinkMs: number;
      thinkSamples: number;
    }
  >();
  const bucket = (turn: number | null) => {
    const groupKey = `t${String(turn)}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        turn,
        output: 0,
        ttftMs: 0,
        decodeMs: 0,
        samples: 0,
        thinkMs: 0,
        thinkSamples: 0,
      };
      groups.set(groupKey, group);
      order.push(groupKey);
    }
    return group;
  };

  // Output counts EVERY settled call, including ones that never streamed — dsh's
  // own totals do the same, so the rate and the token total stay on one scale.
  for (const step of committedSteps(state)) bucket(step.turn).output += step.output;

  // TTFT and decode come from the step's timing slot instead: a call can stream
  // and settle without a usage block and dsh still counts its span. A call that
  // never streamed contributes no sample rather than a zero that would drag the
  // average down.
  for (const [key, start] of state.starts) {
    const chunk = state.chunks.get(key);
    if (chunk === undefined) continue;
    const group = bucket(start.turn);
    group.ttftMs += Math.max(0, chunk.first - start.at);
    group.decodeMs += Math.max(0, chunk.last - chunk.first);
    group.samples += 1;
    if (chunk.think !== null) {
      group.thinkMs += Math.max(0, chunk.think[1] - chunk.think[0]);
      group.thinkSamples += 1;
    }
  }
  if (order.length === 0) return { last: null, speed: null };

  const turns = order
    .map((key) => groups.get(key))
    .filter((group): group is NonNullable<typeof group> => group !== undefined)
    .sort((a, b) => (a.turn ?? -1) - (b.turn ?? -1))
    .map((group) => {
      const thinkMs = group.thinkSamples > 0 ? group.thinkMs : null;
      return {
        turn: group.turn,
        output: group.output,
        // The model side is TTFT + decode; tool execution is outside it.
        modelMs: group.ttftMs + group.decodeMs,
        ttftMs: group.ttftMs,
        decodeMs: group.decodeMs,
        samples: group.samples,
        tokensPerSecond: speed(group.output, group.decodeMs),
        thinkMs,
        // "Output" is everything generated after the first token that is not
        // thinking — the reply plus the tool-call arguments. Defining it as the
        // remainder keeps 生成 = 思考 + 输出 exact instead of leaving a gap.
        outMs: thinkMs === null ? null : Math.max(0, group.decodeMs - thinkMs),
      };
    });

  const totals: SpeedTotals = {
    turns: state.turnCount,
    steps: state.stepCount,
    output: 0,
    modelMs: 0,
    ttftMs: 0,
    decodeMs: 0,
    samples: 0,
    toolMs: unionMs(state.toolIntervals),
    ttftAvgMs: null,
    tokensPerSecond: null,
    thinkMs: null,
    outMs: null,
  };
  let thinkSamples = 0;
  for (const turn of turns) {
    totals.output += turn.output;
    totals.modelMs += turn.modelMs;
    totals.ttftMs += turn.ttftMs;
    totals.decodeMs += turn.decodeMs;
    totals.samples += turn.samples;
    if (turn.thinkMs !== null) thinkSamples += 1;
  }
  if (thinkSamples > 0) {
    totals.thinkMs = turns.reduce((sum, turn) => sum + (turn.thinkMs ?? 0), 0);
    totals.outMs = Math.max(0, totals.decodeMs - totals.thinkMs);
  }
  totals.tokensPerSecond = speed(totals.output, totals.decodeMs);
  totals.ttftAvgMs = totals.samples > 0 ? totals.ttftMs / totals.samples : null;
  return { last: turns[turns.length - 1], speed: totals };
}

function logTotals(state: LogState): UsageTotals | null {
  if (state.steps.length === 0) return null;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  for (const step of committedSteps(state)) {
    input += step.input;
    cacheRead += step.cacheRead;
    cacheWrite += step.cacheWrite;
    output += step.output;
  }
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    hitPct: percent(cacheRead, input + cacheRead + cacheWrite),
  };
}

export function readDshUsage(sessionId: string, home = homedir()): DshSnapshot | null {
  const logPath = findLogPath(home, sessionId);
  const projection = readProjection(home, sessionId);
  if (!logPath && projection.totals === null && projection.context === null) return null;

  let state: LogState | null = null;
  if (logPath) {
    try {
      state = readLog(logPath);
    } catch {
      state = null;
    }
  }
  const logMtimeMs = state?.mtimeMs ?? null;

  const ages = [logMtimeMs, projection.mtimeMs].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  const freshBases = ages.length > 0 ? Math.max(...ages) : Date.now();
  const speeds = state ? turnSpeeds(state) : { last: null, speed: null };

  return {
    observedAt: Date.now(),
    sourceAgeMs: Math.max(0, Date.now() - freshBases),
    inFlight: state !== null && state.open.size > 0,
    last: state ? lastStep(state) : null,
    totals: projection.totals ?? (state ? logTotals(state) : null),
    context: projection.context,
    turnSpeed: speeds.last,
    speed: speeds.speed,
    timing: (() => {
      if (!state) return { totalMs: 0, toolMs: 0, requestMs: 0, otherMs: 0 };
      const openToolMs = 0;
      const toolMs = unionMs(state.toolIntervals) + openToolMs;
      const requestMs = Math.min(state.requestMs, Math.max(0, state.totalMs - toolMs));
      const otherMs = Math.max(0, state.totalMs - toolMs - requestMs);
      return { totalMs: state.totalMs, toolMs, requestMs, otherMs };
    })(),
  };
}
