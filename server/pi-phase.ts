/**
 * pi phase aggregate — the only data source that knows per-request first-token
 * and think/output wall times across the WHOLE thread.
 *
 * The pi statusline extension appends one row per model call to
 * `~/.pi/agent/statusline-samples.jsonl` (`session`, `ttftMs`, `decodeMs`,
 * `thinkMs`, `outMs`). Rows are keyed by the session id that made the call, so
 * a resumed thread is covered by walking the `parentSession` chain recorded in
 * the session-file headers (each value is the parent session file's path).
 *
 * Rows are folded incrementally (the file is 8 MB and grows for the lifetime of
 * the agent directory), so each byte is parsed exactly once across all agents.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAppendedJsonl } from "./incremental-jsonl.ts";

export interface PhaseAggregate {
  /** Σ time from request to first streamed token. */
  ttftMs: number;
  /** Σ pure decode window (first token -> message landed). */
  decodeMs: number;
  /** Σ measured think / out streaming wall time. */
  thinkMs: number;
  outMs: number;
  /** Σ output tokens of the sampled calls, for the TPS numerator. */
  output: number;
  /** Sampled model calls behind the aggregate. */
  count: number;
  /**
   * Samples that actually carried a `thinkMs` field. Older statusline versions
   * wrote rows without it, and those must read as "unknown", not as 0 seconds of
   * thinking.
   */
  thinkSamples: number;
}

function emptyPhase(): PhaseAggregate {
  return { ttftMs: 0, decodeMs: 0, thinkMs: 0, outMs: 0, output: 0, count: 0, thinkSamples: 0 };
}

/** Per-session aggregates, folded once per appended sample row. */
const bySession = new Map<string, PhaseAggregate>();

/** session file path -> thread session ids (self + resumed ancestors). */
const chainCache = new Map<string, string[]>();

/**
 * Size the samples file had at the previous fold. `readAppendedJsonl` restarts
 * from byte 0 when it sees the file shrink (truncate/rotate), so the per-session
 * sums must be dropped in the same breath or every re-read row is added twice.
 */
let samplesSize = 0;

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** First line of a pi session file is the session header. */
function readHeader(path: string): { id?: string; parentSession?: string } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(8192);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0];
    const parsed = JSON.parse(first) as { type?: unknown; id?: unknown; parentSession?: unknown };
    if (parsed.type !== "session") return undefined;
    return {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      parentSession: typeof parsed.parentSession === "string" ? parsed.parentSession : undefined,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Self + ancestor session ids, max 32 hops (bad data must not loop forever). */
function threadSessionIds(sessionPath: string, sessionId: string): string[] {
  const cached = chainCache.get(sessionPath);
  if (cached) return cached;
  const ids: string[] = [];
  const seen = new Set<string>();
  let header = readHeader(sessionPath);
  if (header?.id) sessionId = header.id;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!sessionId || seen.has(sessionId)) break;
    seen.add(sessionId);
    ids.push(sessionId);
    const parentPath = header?.parentSession;
    if (!parentPath) break;
    header = readHeader(parentPath);
    if (!header?.id) break;
    sessionId = header.id;
  }
  chainCache.set(sessionPath, ids);
  return ids;
}

function foldNewRows(samplesPath: string): void {
  for (const raw of readAppendedJsonl(samplesPath)) {
    const row = raw as Record<string, unknown>;
    if (typeof row.session !== "string") continue;
    let agg = bySession.get(row.session);
    if (!agg) {
      agg = emptyPhase();
      bySession.set(row.session, agg);
    }
    agg.ttftMs += numberOr0(row.ttftMs);
    agg.decodeMs += numberOr0(row.decodeMs);
    // Only a row that actually carries the field counts as a thinking sample;
    // absence means "this statusline version had no such measurement".
    if (typeof row.thinkMs === "number" && Number.isFinite(row.thinkMs)) {
      agg.thinkMs += row.thinkMs;
      agg.thinkSamples += 1;
    }
    agg.outMs += numberOr0(row.outMs);
    agg.output += numberOr0(row.out);
    agg.count += 1;
  }
}

/**
 * Aggregate the thread's phase samples. Returns null when the statusline never
 * wrote a sample for this thread (extension absent, or thread predates it).
 */
export function piPhaseAggregate(home: string, sessionPath: string, sessionId: string): PhaseAggregate | null {
  const samplesPath = join(home, ".pi", "agent", "statusline-samples.jsonl");
  if (existsSync(samplesPath)) {
    try {
      // The reader silently restarts at byte 0 when the file shrinks, so the
      // folded sums must be dropped first or those rows count twice.
      const size = statSync(samplesPath).size;
      if (size < samplesSize) {
        bySession.clear();
        chainCache.clear();
      }
      samplesSize = size;
      foldNewRows(samplesPath);
    } catch {
      // unreadable samples file: fall through to whatever was folded before
    }
  }
  const total = emptyPhase();
  let seen = false;
  for (const id of threadSessionIds(sessionPath, sessionId)) {
    const agg = bySession.get(id);
    if (!agg) continue;
    seen = true;
    total.ttftMs += agg.ttftMs;
    total.decodeMs += agg.decodeMs;
    total.thinkMs += agg.thinkMs;
    total.outMs += agg.outMs;
    total.output += agg.output;
    total.count += agg.count;
    total.thinkSamples += agg.thinkSamples;
  }
  return seen ? total : null;
}
