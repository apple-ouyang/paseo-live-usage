/**
 * A real Grok session directory in a throwaway HOME, for the tests.
 *
 * Grok keeps two files per session: `events.jsonl` (append-only turn timeline —
 * `turn_started`/`turn_ended`, `loop_started`, `phase_changed`,
 * `tool_started`/`tool_completed`) and `usage.json` (the CLI's token + cost
 * ledger, rewritten when a turn settles). Both are built here exactly as the
 * CLI writes them, so the tests exercise the real parser.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fixed epoch so every assertion can be an exact number. */
export const T0 = 1_790_000_000_000;

export interface LedgerTurnInput {
  turnNumber: number;
  endedAt: number;
  /**
   * The ledger's own `inputTokens`: the FULL prompt, cache buckets included.
   * Grok's ACP usage struct keeps the cache inside this number (only its
   * headless projector subtracts it), so tests state it that way and let the
   * adapter normalize.
   */
  promptTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  calls?: number;
}

/** The ledger shape `grok usage <sid>` prints, built from per-turn inputs. */
export function grokLedger(turns: LedgerTurnInput[], costTicks = 0): Record<string, unknown> {
  const rows = turns.map((turn) => ({
    turnNumber: turn.turnNumber,
    endedAt: new Date(turn.endedAt).toISOString(),
    inputTokens: turn.promptTokens ?? 0,
    outputTokens: turn.output ?? 0,
    cachedReadTokens: turn.cacheRead ?? 0,
    cacheCreationTokens: turn.cacheWrite ?? 0,
    reasoningTokens: turn.reasoning ?? 0,
    // `totalTokens = full input + output`: the cache sits inside `inputTokens`.
    totalTokens: (turn.promptTokens ?? 0) + (turn.output ?? 0),
    modelCalls: turn.calls ?? 1,
    costUsdTicks: 0,
    turnCount: 1,
    primaryModelId: "grok-4.7-build",
  }));
  const sum = (pick: (turn: LedgerTurnInput) => number) =>
    turns.reduce((total, turn) => total + pick(turn), 0);
  return {
    sessionId: "fixture",
    updatedAt: new Date(turns.length > 0 ? turns[turns.length - 1].endedAt : T0).toISOString(),
    session: {
      inputTokens: sum((t) => t.promptTokens ?? 0),
      outputTokens: sum((t) => t.output ?? 0),
      cachedReadTokens: sum((t) => t.cacheRead ?? 0),
      cacheCreationTokens: sum((t) => t.cacheWrite ?? 0),
      reasoningTokens: sum((t) => t.reasoning ?? 0),
      totalTokens: sum((t) => (t.promptTokens ?? 0) + (t.output ?? 0)),
      modelCalls: sum((t) => t.calls ?? 1),
      costUsdTicks: costTicks,
      turnCount: turns.length,
      primaryModelId: "grok-4.7-build",
    },
    turns: rows,
  };
}

export function newGrokSession(sessionId = "55555555-6666-7777-8888-999999999999") {
  const home = mkdtempSync(join(tmpdir(), "live-usage-grok-"));
  // Grok names the per-cwd level with the URL-encoded working directory.
  const dir = join(home, ".grok", "sessions", encodeURIComponent("/tmp/grok-fixture"), sessionId);
  mkdirSync(dir, { recursive: true });
  const events: string[] = [];
  const event = (type: string, ms: number, extra: Record<string, unknown> = {}) => {
    events.push(JSON.stringify({ ts: new Date(ms).toISOString(), type, ...extra }));
  };
  return {
    home,
    sessionId,
    dir,
    eventsPath: join(dir, "events.jsonl"),
    usagePath: join(dir, "usage.json"),
    turnStarted(turnNumber: number, ms: number) {
      event("turn_started", ms, {
        turn_number: turnNumber,
        session_id: sessionId,
        model_id: "grok-4.7-build",
        schema_version: "1.0",
      });
    },
    loopStarted(ms: number, index = 0) {
      event("loop_started", ms, { loop_index: index });
    },
    phase(phase: string, ms: number) {
      event("phase_changed", ms, { phase });
    },
    toolStarted(name: string, ms: number) {
      event("tool_started", ms, { tool_name: name });
    },
    toolCompleted(name: string, ms: number, durationMs = 100) {
      event("tool_completed", ms, {
        tool_name: name,
        tool_call_id: `${name}-1`,
        duration_ms: durationMs,
        outcome: "success",
      });
    },
    turnEnded(ms: number) {
      event("turn_ended", ms, {});
    },
    writeEvents(): void {
      writeFileSync(this.eventsPath, `${events.join("\n")}\n`);
    },
    writeUsage(ledger: Record<string, unknown>): void {
      writeFileSync(this.usagePath, JSON.stringify(ledger));
    },
    cleanup(): void {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
