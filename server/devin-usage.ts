/**
 * Devin CLI usage reader.
 *
 * Devin runs under Paseo as an ACP provider (`devin acp`) and reports no usage
 * over ACP, so `agent.lastUsage` is always null. Devin persists every committed
 * message to `~/.local/share/devin/cli/sessions.db` (SQLite, WAL):
 *
 *   message_nodes(row_id AUTOINCREMENT, session_id, node_id, created_at, chat_message)
 *
 * `chat_message` JSON carries what the plugin needs:
 *   - assistant rows: metadata.metrics {input_tokens, output_tokens,
 *     cache_read_tokens, cache_creation_tokens, total_time_ms, ttft_ms}
 *     with Anthropic-style accounting (input excludes cache reads), plus
 *     metadata.created_at (ISO, ms precision) and top-level tool_calls[].
 *   - tool rows: metadata.extensions["chisel/tool_call_timing"]
 *     {started_at, finished_at, duration_ms} — real tool wall clock.
 *   - user rows: metadata.is_user_input === true marks a real prompt (turn start).
 *
 * Rows are append-only by row_id, so each poll selects only rows after the last
 * seen one — the SQLite equivalent of incremental-jsonl. Reading prefers
 * node:sqlite (Paseo plugins run under Electron's Node 24); if that builtin is
 * unavailable the reader falls back to the macOS sqlite3 CLI.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const MIN_SAMPLE_MS = 250;
const ROWS_PER_QUERY = 4000;
const SQLITE3_CLI = "/usr/bin/sqlite3";

const ROWS_SQL = `
SELECT row_id AS rowId,
       created_at AS createdAtSec,
       json_extract(chat_message, '$.role') AS role,
       json_extract(chat_message, '$.message_id') AS messageId,
       json_extract(chat_message, '$.metadata') AS metadataJson,
       json_extract(chat_message, '$.tool_calls') AS toolCallsJson
FROM message_nodes
WHERE session_id = ?1 AND row_id > ?2
ORDER BY row_id ASC
LIMIT ${ROWS_PER_QUERY}`;

interface DevinRow {
  rowId: number;
  createdAtSec: number | null;
  role: string | null;
  messageId: string | null;
  metadataJson: string | null;
  toolCallsJson: string | null;
}

interface DevinDb {
  db: DatabaseSync | null;
  stmt: ReturnType<DatabaseSync["prepare"]> | null;
  /** node:sqlite unavailable/failed; rows come from the sqlite3 CLI instead. */
  cli: boolean;
}

const devinDbs = new Map<string, DevinDb>();

/**
 * node:sqlite is resolved lazily through getBuiltinModule: a static import would
 * throw at module load on a runtime without the builtin, killing the whole
 * plugin (all providers) before the CLI fallback could engage.
 */
function openSqlite(path: string): DatabaseSync | null {
  const mod = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (!mod) return null;
  try {
    return new mod.DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

function devinDb(path: string): DevinDb | null {
  const cached = devinDbs.get(path);
  if (cached) return cached;
  const handle: DevinDb = { db: openSqlite(path), stmt: null, cli: false };
  if (!handle.db) handle.cli = true;
  devinDbs.set(path, handle);
  return handle;
}

function cliSql(sessionId: string, afterRowId: number): string {
  const escaped = sessionId.replaceAll("'", "''");
  return ROWS_SQL.replace(/\?[12]/g, (m) => (m === "?1" ? `'${escaped}'` : String(afterRowId)));
}

function readRows(handle: DevinDb, dbPath: string, sessionId: string, afterRowId: number): DevinRow[] {
  if (handle.db) {
    try {
      handle.stmt ??= handle.db.prepare(ROWS_SQL);
      return handle.stmt.all(sessionId, afterRowId) as unknown as DevinRow[];
    } catch {
      handle.db = null;
      handle.stmt = null;
      handle.cli = true;
    }
  }
  if (!handle.cli) return [];
  try {
    const out = execFileSync(SQLITE3_CLI, ["-readonly", "-json", dbPath, cliSql(sessionId, afterRowId)], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows: unknown = JSON.parse(out.trim() === "" ? "[]" : out);
    return Array.isArray(rows) ? (rows as DevinRow[]) : [];
  } catch {
    return [];
  }
}

/* ────────────────────────────── state ────────────────────────────── */

export interface DevinStep {
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

export interface DevinTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  hitPct: number | null;
}

export interface DevinTiming {
  totalMs: number;
  toolMs: number;
  requestMs: number;
  otherMs: number;
}

/**
 * devin reports the same split dsh does: `metrics.ttft_ms` is the wait for the
 * first token, and `metrics.tokens_per_sec` is output ÷ (total_time_ms − ttft_ms).
 * These are the raw sums; the collector turns them into the panel's speed row.
 */
export interface DevinSpeed {
  ttftMs: number;
  decodeMs: number;
  output: number;
  samples: number;
  turns: number;
  steps: number;
  toolMs: number;
}

export interface DevinSnapshot {
  observedAt: number;
  sourceAgeMs: number;
  inFlight: boolean;
  last: DevinStep | null;
  totals: DevinTotals | null;
  context: null;
  timing: DevinTiming;
  speed: DevinSpeed | null;
}

interface DevinBuckets {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface DevinState {
  last: DevinStep | null;
  totals: DevinTotals;
  /** Dedupe by message_id in case a committed message is rewritten. */
  messages: Map<string, DevinBuckets>;
  prevAt: number | null;
  inFlight: boolean;
  inTurn: boolean;
  /** Sum of per-request metrics.total_time_ms — real request wall clock. */
  requestMs: number;
  /** Turn wall clock from committed-row gaps (idle between turns excluded). */
  totalMs: number;
  toolIntervals: Array<[number, number]>;
  lastRowId: number;
  changeAt: number;
  /** Became true once at least one row matched this session id. */
  seenAny: boolean;
  /** Per-message decode contribution, so a rewritten row replaces, not adds. */
  speedByMessage: Map<
    string,
    { ttftMs: number; decodeMs: number; output: number; counted: boolean }
  >;
  speed: { ttftMs: number; decodeMs: number; output: number; samples: number };
  turns: number;
  steps: number;
}

const devinStates = new Map<string, DevinState>();

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

function hitRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  return percent(cacheRead, input + cacheRead + cacheWrite);
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

function stepSpeed(output: number, stepMs: number | null): number | null {
  if (stepMs === null || stepMs < MIN_SAMPLE_MS) return null;
  return output / (stepMs / 1000);
}

function applyRow(state: DevinState, row: DevinRow): void {
  state.seenAny = true;
  state.lastRowId = Math.max(state.lastRowId, row.rowId);

  const meta =
    row.metadataJson === null ? null : (JSON.parse(row.metadataJson) as Record<string, unknown>);
  const at =
    parseTime(meta?.created_at) ?? (row.createdAtSec !== null ? row.createdAtSec * 1000 : null);
  const role = row.role;

  if (role === "user" && meta?.is_user_input === true) {
    // A real prompt starts a new turn; idle between turns is not counted.
    state.inTurn = true;
    state.inFlight = true;
    state.turns += 1;
    if (at !== null) state.prevAt = at;
    return;
  }

  if (role === "tool") {
    const extensions = meta?.extensions as Record<string, unknown> | undefined;
    const toolTiming = extensions?.["chisel/tool_call_timing"] as
      | Record<string, unknown>
      | undefined;
    const started = parseTime(toolTiming?.started_at);
    const finished = parseTime(toolTiming?.finished_at);
    if (started !== null && finished !== null && finished > started) {
      state.toolIntervals.push([started, finished]);
    }
    if (state.inTurn && at !== null && state.prevAt !== null) {
      const gap = at - state.prevAt;
      if (gap > 0) state.totalMs += gap;
    }
    if (at !== null) state.prevAt = at;
    state.inFlight = true;
    return;
  }

  if (role !== "assistant") {
    // Bookkeeping rows (system injections, non-input user entries) advance the
    // cursor without counting: their gap is never provably work.
    if (at !== null) state.prevAt = at;
    return;
  }

  if (state.inTurn && at !== null && state.prevAt !== null) {
    const gap = at - state.prevAt;
    if (gap > 0) state.totalMs += gap;
  }

  const metrics = meta?.metrics as Record<string, unknown> | null | undefined;
  if (metrics) {
    const buckets: DevinBuckets = {
      input: asNumber(metrics.input_tokens),
      cacheRead: asNumber(metrics.cache_read_tokens),
      cacheWrite: asNumber(metrics.cache_creation_tokens),
      output: asNumber(metrics.output_tokens),
    };
    const id = row.messageId ?? `row:${row.rowId}`;
    const previous = state.messages.get(id) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    state.totals = {
      input: state.totals.input + Math.max(0, buckets.input - previous.input),
      cacheRead: state.totals.cacheRead + Math.max(0, buckets.cacheRead - previous.cacheRead),
      cacheWrite: state.totals.cacheWrite + Math.max(0, buckets.cacheWrite - previous.cacheWrite),
      output: state.totals.output + Math.max(0, buckets.output - previous.output),
      hitPct: null,
    };
    state.messages.set(id, buckets);

    const stepMs = optionalMs(metrics.total_time_ms);
    if (stepMs !== null) state.requestMs += stepMs;

    // devin already reports dsh's split: `ttft_ms` is the wait for the first
    // token and `tokens_per_sec` is output ÷ (total_time_ms − ttft_ms). Fold it
    // with per-message replacement so a rewritten row does not double count.
    // Only a call that actually reported a TTFT is a sample — otherwise the
    // average would be divided by calls that never measured one. Such a call
    // contributes NO decode window either: keeping its whole `total_time_ms`
    // would inflate the denominator while it stays out of `samples`, silently
    // lowering TPS (measured: 81.9 vs the correct 96.7 t/s on a real session).
    const ttftRaw = optionalMs(metrics.ttft_ms);
    const ttftMs = ttftRaw ?? 0;
    const decodeMs =
      ttftRaw !== null && stepMs !== null && stepMs > ttftMs ? stepMs - ttftMs : 0;
    const previousSpeed = state.speedByMessage.get(id);
    state.speed.ttftMs += ttftMs - (previousSpeed?.ttftMs ?? 0);
    state.speed.decodeMs += decodeMs - (previousSpeed?.decodeMs ?? 0);
    state.speed.output += buckets.output - (previousSpeed?.output ?? 0);
    if (previousSpeed === undefined) state.steps += 1;
    if (ttftRaw !== null && previousSpeed?.counted !== true) state.speed.samples += 1;
    else if (ttftRaw === null && previousSpeed?.counted === true) state.speed.samples -= 1;
    state.speedByMessage.set(id, {
      ttftMs,
      decodeMs,
      output: buckets.output,
      counted: ttftRaw !== null,
    });

    state.last = {
      output: buckets.output,
      reasoning: 0,
      input: buckets.input,
      cacheRead: buckets.cacheRead,
      cacheWrite: buckets.cacheWrite,
      stepMs,
      tokensPerSecond: stepSpeed(buckets.output, stepMs),
      hitPct: hitRate(buckets.input, buckets.cacheRead, buckets.cacheWrite),
      endedAt: at,
    };
  }

  const toolCalls = row.toolCallsJson === null ? null : (JSON.parse(row.toolCallsJson) as unknown);
  state.inFlight = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (at !== null) state.prevAt = at;
}

export function readDevinUsage(sessionId: string, home = homedir(), now = Date.now()): DevinSnapshot | null {
  const dbPath = join(home, ".local", "share", "devin", "cli", "sessions.db");
  if (!existsSync(dbPath)) return null;
  const handle = devinDb(dbPath);
  if (!handle) return null;

  const key = `${dbPath}:${sessionId}`;
  let state = devinStates.get(key);
  if (!state) {
    state = {
      last: null,
      totals: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, hitPct: null },
      messages: new Map(),
      prevAt: null,
      inFlight: false,
      inTurn: false,
      requestMs: 0,
      totalMs: 0,
      toolIntervals: [],
      lastRowId: 0,
      changeAt: now,
      seenAny: false,
      speedByMessage: new Map(),
      speed: { ttftMs: 0, decodeMs: 0, output: 0, samples: 0 },
      turns: 0,
      steps: 0,
    };
    devinStates.set(key, state);
  }

  for (;;) {
    const rows = readRows(handle, dbPath, sessionId, state.lastRowId);
    if (rows.length === 0) break;
    state.changeAt = now;
    for (const row of rows) {
      try {
        applyRow(state, row);
      } catch {
        // A malformed row still advances lastRowId so the next poll moves on.
        state.lastRowId = Math.max(state.lastRowId, row.rowId);
      }
    }
    if (rows.length < ROWS_PER_QUERY) break;
  }

  if (!state.seenAny) return null;

  const toolMs = unionMs(state.toolIntervals);
  const totalMs = Math.max(state.totalMs, state.requestMs + toolMs);
  const requestMs = Math.min(state.requestMs, Math.max(0, totalMs - toolMs));

  const totals = state.totals;
  return {
    observedAt: now,
    sourceAgeMs: Math.max(0, now - state.changeAt),
    inFlight: state.inFlight,
    last: state.last,
    totals:
      totals.output > 0 || totals.input > 0
        ? { ...totals, hitPct: hitRate(totals.input, totals.cacheRead, totals.cacheWrite) }
        : null,
    context: null,
    timing: {
      totalMs,
      toolMs,
      requestMs,
      otherMs: Math.max(0, totalMs - toolMs - requestMs),
    },
    speed:
      state.speed.samples > 0
        ? {
            ...state.speed,
            turns: state.turns,
            steps: state.steps,
            toolMs,
          }
        : null,
  };
}
