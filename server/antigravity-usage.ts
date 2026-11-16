/**
 * Antigravity (agy) usage reader.
 *
 * Native `agy acp` sessions (`provider === "antigravity"`) return an ACP
 * `sessionId` that equals the conversation filename stem directly:
 * `~/.gemini/antigravity-cli/conversations/<sessionId>.db`.
 *
 * Legacy `agy-acp` sessions (`provider === "antigravity-cli"`) map ACP session
 * ids via `~/.agy-acp-state/sessions.json` to `conversationId`, or fall back to
 * the newest unclaimed `.db` file during the first turn.
 *
 * One `gen_metadata` row lands per completed model call (`exa.cortex_pb.CortexStepGeneratorMetadata`):
 *   - field 1 (`chat_model`: `ChatModelMetadata`):
 *     - field 4  → `ModelUsageStats` {2 input_tokens (fresh, uncached),
 *                                     3 output_tokens (already includes thinking),
 *                                     4 cache_write_tokens, 5 cache_read_tokens,
 *                                     9 thinking_output_tokens, 10 response_output_tokens}
 *     - field 9  → `ChatStartMetadata` {10 → `ContextWindowMetadata` {1 estimated_tokens_used, 4 max_context_tokens}}
 *     - field 11 → `time_to_first_token` (`google.protobuf.Duration` {1 seconds, 2 nanos})
 *     - field 12 → `streaming_duration` (`google.protobuf.Duration` {1 seconds, 2 nanos})
 *     - field 15 → `CompletionConfig` {2 max_tokens}
 *     - field 17 → `retry_infos` {2 → `ModelUsageStats`} fallback when field 4 absent/empty
 *     - field 19 → `response_model` slug, field 21 → `model_display_name`
 *   - field 2 (`step_indices`: `repeated uint32`, first index is the `step_type = 15` step)
 *   - field 4 (`execution_id`: turn identifier shared by all steps in the same turn)
 *
 * And `steps` carries per-step timestamps and durations:
 *   - `step_type = 14`: user prompt (one per turn)
 *   - `step_type = 15`: planner response (`metadata` has `created_at` [1], `viewable_at` [6],
 *     `finished_generating_at` [7], `completed_at` [8], `execution_id` [12]; `step_payload`
 *     has `planner_response` [20] → `thinking_duration` [11], measured from `created_at` to
 *     the end of streamed thinking)
 *   - `step_type = 132`: tool call (`metadata` has `started_at` [32], `finished_generating_at` [7],
 *     `completed_at` [8] for real tool execution intervals)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SQLITE3_CLI = "/usr/bin/sqlite3";
const MIN_SAMPLE_MS = 250;
const ROWS_SQL =
  "SELECT idx, hex(data) AS dataHex FROM gen_metadata WHERE idx > ?1 ORDER BY idx LIMIT 4000";
const STEPS_FULL_SQL =
  "SELECT idx, step_type AS stepType, status, hex(metadata) AS metaHex, CASE WHEN step_type = 15 THEN hex(step_payload) ELSE NULL END AS payloadHex FROM steps WHERE idx > ?1 ORDER BY idx LIMIT 4000";
const STEPS_MIN_SQL =
  "SELECT idx, step_type AS stepType, status FROM steps WHERE idx > ?1 ORDER BY idx LIMIT 4000";
/** step_type 14 is the user-prompt row — one per turn (per agy-acp). */
const TURNS_SQL = "SELECT COUNT(*) AS turns FROM steps WHERE step_type = 14";

/* ── minimal protobuf wire reader ─────────────────────────────────── */

class WireReader {
  pos = 0;
  private readonly buf: Uint8Array;
  readonly len: number;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.len = buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.len) throw new Error("premature EOF in varint");
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("varint too long");
    }
  }

  tag(): number {
    return Number(this.varint());
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.len) throw new Error("premature EOF in bytes");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  int(): number {
    const value = this.varint();
    const num = Number(BigInt.asIntN(64, value));
    if (!Number.isSafeInteger(num)) throw new Error("int64 out of range");
    return num;
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.bytes();
        return;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
    if (this.pos > this.len) throw new Error("premature EOF in skip");
  }
}

type FieldHandlers<M> = Record<number, (m: M, r: WireReader, wire: number) => void>;

function readMessage<M>(bytes: Uint8Array, base: M, fields: FieldHandlers<M>): M {
  const reader = new WireReader(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.tag();
    const wire = tag & 7;
    const handler = fields[tag >>> 3];
    if (handler) handler(base, reader, wire);
    else reader.skip(wire);
  }
  return base;
}

function decodeDurationMs(bytes: Uint8Array): number | null {
  const d = readMessage(
    bytes,
    { seconds: 0, nanos: 0 },
    {
      1: (m, r) => (m.seconds = r.int()),
      2: (m, r) => (m.nanos = r.int()),
    },
  );
  const ms = d.seconds * 1000 + d.nanos / 1_000_000;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function decodeTimestampMs(bytes: Uint8Array): number | null {
  const ts = readMessage(
    bytes,
    { seconds: 0, nanos: 0 },
    {
      1: (m, r) => (m.seconds = r.int()),
      2: (m, r) => (m.nanos = r.int()),
    },
  );
  if (ts.seconds <= 0) return null;
  return ts.seconds * 1000 + Math.round(ts.nanos / 1_000_000);
}

/* ── gen_metadata + steps decode (exa.cortex_pb / exa.codeium_common_pb) ── */

interface ModelUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cachedTokens: number;
  thoughtTokens: number;
  contentTokens: number;
}

interface GenBody {
  stats: ModelUsageStats | null;
  estimatedTokensUsed?: number;
  contextWindowSize?: number;
  ttftMs: number | null;
  decodeMs: number | null;
  maxOutputTokens?: number;
  modelSlug?: string;
  modelDisplayName?: string;
}

export interface AgyGeneration {
  idx: number;
  /** Fresh (uncached) input tokens (`ModelUsageStats.input_tokens`, field 2). */
  inputTokens: number;
  /** Alias kept for compatibility with earlier callers/tests. */
  promptTokens: number;
  /** Total output tokens (`ModelUsageStats.output_tokens`, field 3; already includes `thoughtTokens`). */
  outputTokens: number;
  /** Alias kept for compatibility with earlier callers/tests. */
  candidatesTokens: number;
  /** Cache creation tokens (`ModelUsageStats.cache_write_tokens`, field 4). */
  cacheWriteTokens: number;
  /** Cache read tokens (`ModelUsageStats.cache_read_tokens`, field 5). */
  cachedTokens: number;
  /** Reasoning tokens (`ModelUsageStats.thinking_output_tokens`, field 9; subset of `outputTokens`). */
  thoughtTokens: number;
  /** Non-thinking output tokens (`ModelUsageStats.response_output_tokens`, field 10). */
  contentTokens: number;
  /** Full prompt occupancy (`estimated_tokens_used` or `input + cached + cacheWrite`). */
  totalInputTokens: number;
  contextWindowSize?: number;
  modelSlug?: string;
  /** Per-call TTFT from `ChatModelMetadata.time_to_first_token` (field 11). */
  ttftMs: number | null;
  /** Per-call streaming decode window from `ChatModelMetadata.streaming_duration` (field 12). */
  decodeMs: number | null;
  /** Associated `steps.idx` list (`CortexStepGeneratorMetadata.step_indices`, field 2). */
  stepIndices: number[];
  /** Turn identifier (`CortexStepGeneratorMetadata.execution_id`, field 4). */
  executionId: string | null;
}

function statsTotal(s: ModelUsageStats | null): number {
  if (!s) return 0;
  const out = s.outputTokens > 0 ? s.outputTokens : s.contentTokens + s.thoughtTokens;
  return s.inputTokens + s.cachedTokens + s.cacheWriteTokens + out;
}

function decodeStats(bytes: Uint8Array): ModelUsageStats {
  return readMessage(
    bytes,
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cachedTokens: 0,
      thoughtTokens: 0,
      contentTokens: 0,
    },
    {
      2: (m, r) => (m.inputTokens = r.int()),
      3: (m, r) => (m.outputTokens = r.int()),
      4: (m, r) => (m.cacheWriteTokens = r.int()),
      5: (m, r) => (m.cachedTokens = r.int()),
      9: (m, r) => (m.thoughtTokens = r.int()),
      10: (m, r) => (m.contentTokens = r.int()),
    },
  );
}

function decodeBody(bytes: Uint8Array): GenBody {
  return readMessage(
    bytes,
    { stats: null, ttftMs: null, decodeMs: null } as GenBody,
    {
      4: (m, r) => (m.stats = decodeStats(r.bytes())),
      9: (m, r) => {
        const sub = readMessage(
          r.bytes(),
          {} as { estimatedTokensUsed?: number; contextWindowSize?: number },
          {
            10: (m2, r2) => {
              const inner = readMessage(
                r2.bytes(),
                {} as { estimatedTokensUsed?: number; contextWindowSize?: number },
                {
                  1: (m3, r3) => (m3.estimatedTokensUsed = r3.int()),
                  4: (m3, r3) => (m3.contextWindowSize = r3.int()),
                },
              );
              if (inner.estimatedTokensUsed) m2.estimatedTokensUsed = inner.estimatedTokensUsed;
              if (inner.contextWindowSize) m2.contextWindowSize = inner.contextWindowSize;
            },
          },
        );
        if (sub.estimatedTokensUsed) m.estimatedTokensUsed = sub.estimatedTokensUsed;
        if (sub.contextWindowSize) m.contextWindowSize = sub.contextWindowSize;
      },
      11: (m, r) => (m.ttftMs = decodeDurationMs(r.bytes())),
      12: (m, r) => (m.decodeMs = decodeDurationMs(r.bytes())),
      15: (m, r) => {
        const sub = readMessage(r.bytes(), {} as { maxOutputTokens?: number }, {
          2: (m2, r2) => (m2.maxOutputTokens = r2.int()),
        });
        if (sub.maxOutputTokens) m.maxOutputTokens = sub.maxOutputTokens;
      },
      // Upstream #138: the field must be consumed even when stats already exist.
      17: (m, r) => {
        const fallback = r.bytes();
        if (statsTotal(m.stats) === 0) {
          readMessage(fallback, {}, {
            2: (_m2, r2) => {
              const candidate = decodeStats(r2.bytes());
              if (statsTotal(candidate) > 0 || !m.stats) (m as GenBody).stats = candidate;
            },
          });
        }
      },
      19: (m, r) => (m.modelSlug = r.string()),
      21: (m, r) => (m.modelDisplayName = r.string()),
    },
  );
}

export function decodeGenMetadata(idx: number, bytes: Uint8Array): AgyGeneration | null {
  if (bytes.length === 0) return null;
  const wrapper = readMessage(
    bytes,
    {
      body: null as GenBody | null,
      stepIndices: [] as number[],
      executionId: null as string | null,
    },
    {
      1: (m, r) => (m.body = decodeBody(r.bytes())),
      2: (m, r, wire) => {
        if (wire === 2) {
          const packed = new WireReader(r.bytes());
          while (packed.pos < packed.len) m.stepIndices.push(packed.int());
        } else if (wire === 0) {
          m.stepIndices.push(r.int());
        } else {
          r.skip(wire);
        }
      },
      4: (m, r) => {
        const id = r.string();
        if (id.length > 0) m.executionId = id;
      },
    },
  );
  const body = wrapper.body;
  if (!body?.stats) return null;
  const s = body.stats;
  const outputTokens = s.outputTokens > 0 ? s.outputTokens : s.contentTokens + s.thoughtTokens;
  if (s.inputTokens + s.cachedTokens + s.cacheWriteTokens + outputTokens === 0) {
    return null;
  }
  const fullPrompt = s.inputTokens + s.cachedTokens + s.cacheWriteTokens;
  const totalInputTokens =
    body.estimatedTokensUsed && body.estimatedTokensUsed > 0
      ? body.estimatedTokensUsed
      : fullPrompt;
  return {
    idx,
    inputTokens: s.inputTokens,
    promptTokens: s.inputTokens,
    outputTokens,
    candidatesTokens: outputTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    cachedTokens: s.cachedTokens,
    thoughtTokens: s.thoughtTokens,
    contentTokens: s.contentTokens,
    totalInputTokens,
    contextWindowSize: body.contextWindowSize,
    modelSlug: body.modelSlug,
    ttftMs: body.ttftMs,
    decodeMs: body.decodeMs,
    stepIndices: wrapper.stepIndices,
    executionId: wrapper.executionId,
  };
}

interface StepMetaDecoded {
  createdAt: number | null;
  viewableAt: number | null;
  finishedGeneratingAt: number | null;
  completedAt: number | null;
  startedAt: number | null;
  executionId: string | null;
  hasToolCall: boolean;
}

function decodeStepMetadata(bytes: Uint8Array): StepMetaDecoded {
  return readMessage(
    bytes,
    {
      createdAt: null,
      viewableAt: null,
      finishedGeneratingAt: null,
      completedAt: null,
      startedAt: null,
      executionId: null,
      hasToolCall: false,
    } as StepMetaDecoded,
    {
      1: (m, r) => (m.createdAt = decodeTimestampMs(r.bytes())),
      4: (m, r) => {
        r.bytes();
        m.hasToolCall = true;
      },
      6: (m, r) => (m.viewableAt = decodeTimestampMs(r.bytes())),
      7: (m, r) => (m.finishedGeneratingAt = decodeTimestampMs(r.bytes())),
      8: (m, r) => (m.completedAt = decodeTimestampMs(r.bytes())),
      12: (m, r) => {
        const id = r.string();
        if (id.length > 0) m.executionId = id;
      },
      32: (m, r) => (m.startedAt = decodeTimestampMs(r.bytes())),
    },
  );
}

/** Extract `thinking_duration` (`field 20 -> field 11`) from a `step_type = 15` payload. */
function decodeStep15ThinkingMs(bytes: Uint8Array): number | null {
  return readMessage(
    bytes,
    { thinkingDurationMs: null as number | null },
    {
      20: (m, r) => {
        const sub = readMessage(
          r.bytes(),
          { thinkingDurationMs: null as number | null },
          {
            11: (m2, r2) => (m2.thinkingDurationMs = decodeDurationMs(r2.bytes())),
          },
        );
        if (sub.thinkingDurationMs !== null) m.thinkingDurationMs = sub.thinkingDurationMs;
      },
    },
  ).thinkingDurationMs;
}

/* ── session → conversation db ────────────────────────────────────── */

interface AgySessionState {
  conversationId?: string | null;
}

function readSessionState(
  home: string,
): Record<string, AgySessionState> {
  try {
    const raw = JSON.parse(
      readFileSync(join(home, ".agy-acp-state", "sessions.json"), "utf8"),
    ) as { sessions?: Record<string, AgySessionState> };
    return raw.sessions ?? {};
  } catch {
    return {};
  }
}

const CONV_DIR_SUFFIX = join(".gemini", "antigravity-cli", "conversations");

/**
 * Resolve the conversation db for an ACP session. The adapter only fills
 * `conversationId` once the StreamPoller diffs the directory mid-turn, and it
 * persists sessions.json later still — so during the first turn the mapping
 * is empty. Fallback: the newest unclaimed db whose mtime is still moving
 * (agy writes it through the turn). Accumulators are keyed by db path, so
 * when the real id lands the session simply re-reads the right file from
 * idx -1 and the totals stay correct.
 */
function resolveDbPath(sessionId: string, home: string, now: number): string | null {
  const dir = join(home, CONV_DIR_SUFFIX);
  if (sessionId.length > 0 && !sessionId.includes("/") && !sessionId.includes("..")) {
    const direct = join(dir, `${sessionId}.db`);
    if (existsSync(direct)) return direct;
  }
  const sessions = readSessionState(home);
  const conv = sessions[sessionId]?.conversationId;
  if (typeof conv === "string" && conv.length > 0) {
    const path = join(dir, `${conv}.db`);
    return existsSync(path) ? path : null;
  }
  const claimed = new Set(
    Object.values(sessions)
      .map((s) => s.conversationId)
      .filter((c): c is string => typeof c === "string" && c.length > 0),
  );
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of listConversationDbs(dir)) {
    const convId = name.slice(0, -3);
    if (claimed.has(convId)) continue;
    const path = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > 5 * 60_000) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
  }
  return best?.path ?? null;
}

function listConversationDbs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".db"));
  } catch {
    return [];
  }
}

/* ── sqlite access (same pattern as devin-usage) ────────────────────── */

interface AgyDb {
  db: DatabaseSync | null;
  stmt: ReturnType<DatabaseSync["prepare"]> | null;
  stepStmt: ReturnType<DatabaseSync["prepare"]> | null;
  turnStmt: ReturnType<DatabaseSync["prepare"]> | null;
  hasStepBlobs: boolean | null;
  cli: boolean;
}

const agyDbs = new Map<string, AgyDb>();

function openSqlite(path: string): DatabaseSync | null {
  const mod = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (!mod) return null;
  try {
    // Not readOnly: while agy is writing, fresh rows live in the WAL and a
    // read-only open can miss them entirely (observed: COUNT=0 on rows the
    // sqlite3 CLI sees). Plain opens participate in WAL recovery normally.
    return new mod.DatabaseSync(path);
  } catch {
    return null;
  }
}

function agyDb(path: string): AgyDb {
  const cached = agyDbs.get(path);
  if (cached) return cached;
  const handle: AgyDb = {
    db: openSqlite(path),
    stmt: null,
    stepStmt: null,
    turnStmt: null,
    hasStepBlobs: null,
    cli: false,
  };
  if (!handle.db) handle.cli = true;
  agyDbs.set(path, handle);
  return handle;
}

interface AgyRow {
  idx: number;
  dataHex: string;
}

interface AgyStepRow {
  idx: number;
  stepType: number;
  status: number;
  metaHex?: string | null;
  payloadHex?: string | null;
}

function readRows(handle: AgyDb, dbPath: string, afterIdx: number): AgyRow[] {
  if (handle.db) {
    try {
      handle.stmt ??= handle.db.prepare(ROWS_SQL);
      return handle.stmt.all(afterIdx) as unknown as AgyRow[];
    } catch {
      handle.db = null;
      handle.stmt = null;
      handle.stepStmt = null;
      handle.turnStmt = null;
      handle.cli = true;
    }
  }
  if (!handle.cli) return [];
  try {
    const out = execFileSync(
      SQLITE3_CLI,
      ["-readonly", "-json", dbPath, ROWS_SQL.replace(/\?1/g, String(afterIdx))],
      { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 * 1024 },
    );
    const rows: unknown = JSON.parse(out.trim() === "" ? "[]" : out);
    return Array.isArray(rows) ? (rows as AgyRow[]) : [];
  } catch {
    return [];
  }
}

function readStepRows(handle: AgyDb, dbPath: string, afterIdx: number): AgyStepRow[] {
  if (handle.db) {
    try {
      if (!handle.stepStmt) {
        try {
          handle.stepStmt = handle.db.prepare(STEPS_FULL_SQL);
          handle.hasStepBlobs = true;
        } catch {
          handle.stepStmt = handle.db.prepare(STEPS_MIN_SQL);
          handle.hasStepBlobs = false;
        }
      }
      return handle.stepStmt.all(afterIdx) as unknown as AgyStepRow[];
    } catch {
      handle.db = null;
      handle.stmt = null;
      handle.stepStmt = null;
      handle.turnStmt = null;
      handle.cli = true;
    }
  }
  if (!handle.cli) return [];
  const trySql = (sql: string): AgyStepRow[] | null => {
    try {
      const out = execFileSync(
        SQLITE3_CLI,
        ["-readonly", "-json", dbPath, sql.replace(/\?1/g, String(afterIdx))],
        { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 * 1024 },
      );
      const rows: unknown = JSON.parse(out.trim() === "" ? "[]" : out);
      return Array.isArray(rows) ? (rows as AgyStepRow[]) : [];
    } catch {
      return null;
    }
  };
  if (handle.hasStepBlobs !== false) {
    const full = trySql(STEPS_FULL_SQL);
    if (full !== null) {
      handle.hasStepBlobs = true;
      return full;
    }
    handle.hasStepBlobs = false;
  }
  return trySql(STEPS_MIN_SQL) ?? [];
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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

function rate(output: number, decodeMs: number | null): number | null {
  return decodeMs !== null && decodeMs >= MIN_SAMPLE_MS ? output / (decodeMs / 1000) : null;
}

/* ── accumulated state per conversation ───────────────────────────── */

interface Step15Info {
  turn: number | null;
  createdAt: number | null;
  viewableAt: number | null;
  finishedGeneratingAt: number | null;
  completedAt: number | null;
  thinkingDurationMs: number | null;
  executionId: string | null;
}

export interface AgyLatestCall {
  ttftMs: number;
  decodeMs: number;
  output: number;
  tokensPerSecond: number | null;
  at: number | null;
  thinkMs: number | null;
}

export interface AgyTurnSpeed {
  turn: number | null;
  output: number;
  modelMs: number;
  ttftMs: number;
  decodeMs: number;
  samples: number;
  tokensPerSecond: number | null;
  thinkMs: number | null;
  outMs: number | null;
}

export interface AgySpeed {
  turns: number;
  steps: number;
  output: number;
  modelMs: number;
  ttftMs: number;
  decodeMs: number;
  samples: number;
  toolMs: number;
  ttftAvgMs: number | null;
  tokensPerSecond: number | null;
  thinkMs: number | null;
  outMs: number | null;
  latest: AgyLatestCall | null;
}

export interface AgyTiming {
  totalMs: number;
  toolMs: number;
  requestMs: number;
  otherMs: number;
}

interface AgyAccum {
  lastIdx: number;
  lastStepIdx: number;
  settledSteps: Set<number>;
  seenPromptSteps: Set<number>;
  turnCounter: number;
  inFlight: boolean;
  step15: Map<number, Step15Info>;
  toolIntervals: Array<[number, number]>;
  gens: AgyGeneration[];
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  calls: number;
  last: AgyGeneration | null;
}

const accums = new Map<string, AgyAccum>();

export interface AgyUsage {
  /** Σ per-call fresh input tokens (cache reads/writes excluded). */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Σ per-call output tokens (already includes reasoning). */
  output: number;
  reasoning: number;
  calls: number;
  /** User-prompt rows (step_type 14) — one per turn. */
  turns: number;
  inFlight: boolean;
  /** Latest call's breakdown; null before the first call lands. */
  last: AgyGeneration | null;
  lastTurn: number | null;
  lastStep: number | null;
  lastStepMs: number | null;
  lastTokensPerSecond: number | null;
  lastEndedAt: number | null;
  turnSpeed: AgyTurnSpeed | null;
  speed: AgySpeed | null;
  timing: AgyTiming | null;
  /** mtime of the db file: freshest write the store observed. */
  sourceAgeMs: number;
  endedAt: number | null;
}

function isStepInFlight(status: number): boolean {
  // CortexStepStatus: 1 = PENDING, 2 = RUNNING, 8 = GENERATING
  return status === 1 || status === 2 || status === 8;
}

export function readAgyUsage(
  sessionId: string,
  home = homedir(),
  now = Date.now(),
): AgyUsage | null {
  const dbPath = resolveDbPath(sessionId, home, now);
  if (!dbPath) return null;

  // Keyed by db path, not sessionId: when the adapter's conversationId lands
  // late and the fallback resolved a different file first, this session just
  // starts reading the right store — its accumulator still covers every row.
  let acc = accums.get(dbPath);
  if (!acc) {
    // steps.idx and gen_metadata.idx start at 0, so cursors must start at -1.
    acc = {
      lastIdx: -1,
      lastStepIdx: -1,
      settledSteps: new Set(),
      seenPromptSteps: new Set(),
      turnCounter: 0,
      inFlight: false,
      step15: new Map(),
      toolIntervals: [],
      gens: [],
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      calls: 0,
      last: null,
    };
    accums.set(dbPath, acc);
  }

  const handle = agyDb(dbPath);

  // 1. Read `steps` first so step_type = 15/132 timestamps & thinking_duration
  //    are available when joining against `gen_metadata`.
  const stepRows = readStepRows(handle, dbPath, acc.lastStepIdx);
  let canAdvanceStepCursor = true;
  let stepInFlight = false;
  for (const row of stepRows) {
    if (row.stepType === 14 && !acc.seenPromptSteps.has(row.idx)) {
      acc.seenPromptSteps.add(row.idx);
      acc.turnCounter += 1;
    }
    const running = isStepInFlight(row.status);
    if (running) {
      stepInFlight = true;
      canAdvanceStepCursor = false;
    }
    if (!running && !acc.settledSteps.has(row.idx)) {
      acc.settledSteps.add(row.idx);
      let meta: StepMetaDecoded | null = null;
      if (row.metaHex) {
        try {
          meta = decodeStepMetadata(hexToBytes(row.metaHex));
        } catch {
          meta = null;
        }
      }
      if (row.stepType === 15) {
        let thinkingDurationMs: number | null = null;
        if (row.payloadHex) {
          try {
            thinkingDurationMs = decodeStep15ThinkingMs(hexToBytes(row.payloadHex));
          } catch {
            thinkingDurationMs = null;
          }
        }
        acc.step15.set(row.idx, {
          turn: acc.turnCounter > 0 ? acc.turnCounter : null,
          createdAt: meta?.createdAt ?? null,
          viewableAt: meta?.viewableAt ?? null,
          finishedGeneratingAt: meta?.finishedGeneratingAt ?? null,
          completedAt: meta?.completedAt ?? null,
          thinkingDurationMs,
          executionId: meta?.executionId ?? null,
        });
      } else if (row.stepType === 132 || meta?.hasToolCall) {
        const start = meta?.startedAt ?? meta?.finishedGeneratingAt ?? meta?.createdAt ?? null;
        const end = meta?.completedAt ?? null;
        if (start !== null && end !== null && end > start) {
          acc.toolIntervals.push([start, end]);
        }
      }
    }
    if (canAdvanceStepCursor) {
      acc.lastStepIdx = row.idx;
    }
  }
  acc.inFlight = stepInFlight;

  // 2. Read new `gen_metadata` rows.
  for (const row of readRows(handle, dbPath, acc.lastIdx)) {
    let gen: AgyGeneration | null = null;
    try {
      gen = decodeGenMetadata(row.idx, hexToBytes(row.dataHex ?? ""));
    } catch {
      // A committed blob that throws once throws forever; skipping past it
      // (devin's convention) keeps later rows from starving behind a wedge.
      acc.lastIdx = row.idx;
      continue;
    }
    if (!gen) {
      acc.lastIdx = row.idx;
      continue;
    }
    acc.input += gen.inputTokens;
    acc.cacheRead += gen.cachedTokens;
    acc.cacheWrite += gen.cacheWriteTokens;
    acc.output += gen.outputTokens;
    acc.reasoning += gen.thoughtTokens;
    acc.calls += 1;
    acc.last = gen;
    acc.gens.push(gen);
    acc.lastIdx = row.idx;
  }

  if (!acc.last) return null;

  let mtime: number;
  try {
    mtime = statSync(dbPath).mtimeMs;
  } catch {
    // db deleted between resolve and here — retry resolves again next poll.
    return null;
  }

  let turns = acc.turnCounter;
  if (turns === 0) {
    try {
      if (handle.db) {
        handle.turnStmt ??= handle.db.prepare(TURNS_SQL);
        const row = handle.turnStmt.get() as { turns: number } | undefined;
        turns = row?.turns ?? 0;
      } else if (handle.cli) {
        const out = execFileSync(SQLITE3_CLI, ["-readonly", "-json", dbPath, TURNS_SQL], {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 64 * 1024 * 1024,
        });
        const rows = JSON.parse(out.trim() === "" ? "[]" : out) as Array<{ turns: number }>;
        turns = rows[0]?.turns ?? 0;
      }
    } catch {
      turns = 0;
    }
  }

  // 3. Join `acc.gens` with `acc.step15` to compute per-call, per-turn, and session speed/timing.
  const turnOrder: string[] = [];
  const turnGroups = new Map<
    string,
    {
      turn: number | null;
      output: number;
      rateOutput: number;
      rateDecodeMs: number;
      ttftMs: number;
      decodeMs: number;
      samples: number;
      thinkMs: number;
      thinkSamples: number;
    }
  >();

  let latestSample: AgyLatestCall | null = null;
  let lastTurn: number | null = null;
  let lastStepMs: number | null = null;
  let lastDecodeMs: number | null = null;
  let lastEndedAt: number | null = null;

  for (let i = 0; i < acc.gens.length; i += 1) {
    const gen = acc.gens[i];
    const stepIdx = gen.stepIndices[0] ?? gen.idx;
    const step = acc.step15.get(stepIdx);
    const ttftMs =
      gen.ttftMs ??
      (step?.viewableAt !== null &&
      step?.viewableAt !== undefined &&
      step?.createdAt !== null &&
      step?.createdAt !== undefined
        ? Math.max(0, step.viewableAt - step.createdAt)
        : null);
    const decodeMs =
      gen.decodeMs ??
      (step?.finishedGeneratingAt !== null &&
      step?.finishedGeneratingAt !== undefined &&
      step?.viewableAt !== null &&
      step?.viewableAt !== undefined
        ? Math.max(0, step.finishedGeneratingAt - step.viewableAt)
        : null);
    const endedAt = step?.completedAt ?? step?.finishedGeneratingAt ?? null;
    const stepMs =
      ttftMs !== null && decodeMs !== null
        ? ttftMs + decodeMs
        : step?.completedAt !== null &&
            step?.completedAt !== undefined &&
            step?.createdAt !== null &&
            step?.createdAt !== undefined &&
            step.completedAt > step.createdAt
          ? step.completedAt - step.createdAt
          : null;

    // `planner_response.thinking_duration` (field 20 -> field 11) is measured
    // from `step.created_at` to the end of streamed thinking. Subtracting
    // `ttftMs` isolates the thinking portion of `decodeMs`.
    let callThinkMs: number | null = null;
    if (
      step?.thinkingDurationMs !== null &&
      step?.thinkingDurationMs !== undefined &&
      ttftMs !== null &&
      decodeMs !== null
    ) {
      callThinkMs = Math.max(0, Math.min(decodeMs, step.thinkingDurationMs - ttftMs));
    }

    const turnNum = step?.turn ?? null;
    const execId = gen.executionId ?? step?.executionId ?? null;
    const groupKey =
      execId !== null
        ? `exec:${execId}`
        : turnNum !== null
          ? `turn:${turnNum}`
          : `call:${gen.idx}`;

    let group = turnGroups.get(groupKey);
    if (!group) {
      group = {
        turn: turnNum ?? turnOrder.length + 1,
        output: 0,
        rateOutput: 0,
        rateDecodeMs: 0,
        ttftMs: 0,
        decodeMs: 0,
        samples: 0,
        thinkMs: 0,
        thinkSamples: 0,
      };
      turnGroups.set(groupKey, group);
      turnOrder.push(groupKey);
    }
    group.output += gen.outputTokens;
    if (ttftMs !== null && decodeMs !== null) {
      group.ttftMs += ttftMs;
      group.decodeMs += decodeMs;
      group.samples += 1;
      if (decodeMs >= MIN_SAMPLE_MS) {
        group.rateOutput += gen.outputTokens;
        group.rateDecodeMs += decodeMs;
      }
      if (callThinkMs !== null) {
        group.thinkMs += callThinkMs;
        group.thinkSamples += 1;
      }
      latestSample = {
        ttftMs,
        decodeMs,
        output: gen.outputTokens,
        tokensPerSecond: rate(gen.outputTokens, decodeMs),
        at: endedAt ?? mtime,
        thinkMs: callThinkMs,
      };
    }

    if (i === acc.gens.length - 1) {
      lastTurn = group.turn;
      lastStepMs = stepMs;
      lastDecodeMs = decodeMs;
      lastEndedAt = endedAt;
    }
  }

  const toolMs = unionMs(acc.toolIntervals);
  let turnSpeed: AgyTurnSpeed | null = null;
  let speed: AgySpeed | null = null;

  const builtTurns = turnOrder
    .map((k) => turnGroups.get(k)!)
    .filter((g) => g.samples > 0)
    .map((g) => {
      const thinkMs = g.thinkSamples > 0 ? g.thinkMs : null;
      return {
        turn: g.turn,
        output: g.output,
        rateOutput: g.rateOutput,
        rateDecodeMs: g.rateDecodeMs,
        modelMs: g.ttftMs + g.decodeMs,
        ttftMs: g.ttftMs,
        decodeMs: g.decodeMs,
        samples: g.samples,
        tokensPerSecond: rate(g.rateOutput, g.rateDecodeMs),
        thinkMs,
        outMs: thinkMs === null ? null : Math.max(0, g.decodeMs - thinkMs),
      };
    });

  if (builtTurns.length > 0) {
    const lastBuilt = builtTurns[builtTurns.length - 1];
    turnSpeed = {
      turn: lastBuilt.turn,
      output: lastBuilt.output,
      modelMs: lastBuilt.modelMs,
      ttftMs: lastBuilt.ttftMs,
      decodeMs: lastBuilt.decodeMs,
      samples: lastBuilt.samples,
      tokensPerSecond: lastBuilt.tokensPerSecond,
      thinkMs: lastBuilt.thinkMs,
      outMs: lastBuilt.outMs,
    };
    let totalOutput = 0;
    let totalRateOutput = 0;
    let totalRateDecodeMs = 0;
    let totalModelMs = 0;
    let totalTtftMs = 0;
    let totalDecodeMs = 0;
    let totalSamples = 0;
    let thinkTurns = 0;
    let totalThinkMs = 0;
    for (const t of builtTurns) {
      totalOutput += t.output;
      totalRateOutput += t.rateOutput;
      totalRateDecodeMs += t.rateDecodeMs;
      totalModelMs += t.modelMs;
      totalTtftMs += t.ttftMs;
      totalDecodeMs += t.decodeMs;
      totalSamples += t.samples;
      if (t.thinkMs !== null) {
        thinkTurns += 1;
        totalThinkMs += t.thinkMs;
      }
    }
    const sessionThinkMs = thinkTurns > 0 ? totalThinkMs : null;
    speed = {
      turns: Math.max(turns, turnOrder.length),
      steps: acc.calls,
      output: totalOutput,
      modelMs: totalModelMs,
      ttftMs: totalTtftMs,
      decodeMs: totalDecodeMs,
      samples: totalSamples,
      toolMs,
      ttftAvgMs: totalSamples > 0 ? totalTtftMs / totalSamples : null,
      tokensPerSecond: rate(totalRateOutput, totalRateDecodeMs),
      thinkMs: sessionThinkMs,
      outMs: sessionThinkMs === null ? null : Math.max(0, totalDecodeMs - sessionThinkMs),
      latest: latestSample,
    };
  }

  const requestMs = speed ? speed.modelMs : lastStepMs ?? 0;
  const timing: AgyTiming | null =
    requestMs > 0 || toolMs > 0
      ? {
          totalMs: requestMs + toolMs,
          toolMs,
          requestMs,
          otherMs: 0,
        }
      : null;

  return {
    input: acc.input,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    output: acc.output,
    reasoning: acc.reasoning,
    calls: acc.calls,
    turns: Math.max(turns, turnOrder.length),
    inFlight: acc.inFlight,
    last: acc.last,
    lastTurn,
    lastStep: acc.calls,
    lastStepMs,
    lastTokensPerSecond: rate(acc.last.outputTokens, lastDecodeMs ?? lastStepMs),
    lastEndedAt: lastEndedAt ?? mtime,
    turnSpeed,
    speed,
    timing,
    sourceAgeMs: Math.max(0, now - mtime),
    endedAt: lastEndedAt ?? mtime,
  };
}
