/**
 * A real Codex rollout tree in a throwaway HOME, for the tests.
 *
 * Codex appends one JSON object per line: `{timestamp, type, payload}` where the
 * interesting records are `task_started` / `task_complete` (turn span, Codex's own
 * TTFT), `item_completed` (the per-item `[started_at_ms, completed_at_ms]` windows)
 * and `token_count` (cumulative usage). Building the file exactly like the CLI
 * writes it means the tests exercise the real parser rather than a mock.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fixed epoch so every assertion can be an exact number. */
export const T0 = 1_790_000_000_000;

export interface CodexLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

function at(ms: number): string {
  return new Date(ms).toISOString();
}

export function newCodexSession(sessionId = "44444444-5555-6666-7777-888888888888") {
  const home = mkdtempSync(join(tmpdir(), "live-usage-codex-"));
  const dir = join(home, ".codex", "sessions", "2026", "10", "03");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const push = (type: string, ms: number, payload: Record<string, unknown>) => {
    lines.push(JSON.stringify({ timestamp: at(ms), type, payload }));
  };
  return {
    home,
    sessionId,
    path: join(dir, `rollout-2026-10-03T00-00-00-${sessionId}.jsonl`),
    lines,
    push,
    taskStarted(turnId: string, ms: number, startedAtSec = Math.floor(ms / 1000)) {
      push("event_msg", ms, {
        type: "task_started",
        turn_id: turnId,
        started_at: startedAtSec,
        model_context_window: 258_400,
        collaboration_mode_kind: "default",
      });
    },
    taskComplete(
      turnId: string,
      ms: number,
      input: { startedAtSec: number; completedAtSec: number; durationMs: number; ttftMs?: number },
    ) {
      push("event_msg", ms, {
        type: "task_complete",
        turn_id: turnId,
        started_at: input.startedAtSec,
        completed_at: input.completedAtSec,
        duration_ms: input.durationMs,
        ...(input.ttftMs === undefined ? {} : { time_to_first_token_ms: input.ttftMs }),
        last_agent_message: null,
      });
    },
    /** `end - start === 0` reproduces the zero-length windows Codex writes. */
    item(turnId: string, type: string, startMs: number, endMs: number, extra: Record<string, unknown> = {}) {
      push("event_msg", endMs, {
        type: "item_completed",
        thread_id: "thread-1",
        turn_id: turnId,
        item: { type, id: `${type}-1`, ...extra },
        started_at_ms: startMs,
        completed_at_ms: endMs,
      });
    },
    /** Old rollouts carry only `completed_at_ms` plus the item's own `duration`. */
    legacyItem(
      turnId: string,
      type: string,
      completedAtMs: number,
      durationMs: number,
      extra: Record<string, unknown> = {},
    ) {
      push("event_msg", completedAtMs, {
        type: "item_completed",
        thread_id: "thread-1",
        turn_id: turnId,
        item: { type, id: `${type}-1`, duration: { secs: Math.floor(durationMs / 1000), nanos: (durationMs % 1000) * 1e6 }, ...extra },
        completed_at_ms: completedAtMs,
      });
    },
    tokenCount(ms: number, input: { output: number; reasoning?: number; lastOutput?: number }) {
      push("event_msg", ms, {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 900,
            cache_write_input_tokens: 0,
            output_tokens: input.output,
            reasoning_output_tokens: input.reasoning ?? 0,
            total_tokens: 1_000 + input.output,
          },
          last_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 900,
            cache_write_input_tokens: 0,
            output_tokens: input.lastOutput ?? input.output,
            reasoning_output_tokens: input.reasoning ?? 0,
            total_tokens: 1_000 + (input.lastOutput ?? input.output),
          },
          model_context_window: 258_400,
        },
        rate_limits: null,
      });
    },
    /** Legacy shell-tool pair: `custom_tool_call` then its output. */
    toolPair(callId: string, startMs: number, endMs: number, kind: "custom_tool_call" | "function_call" = "custom_tool_call") {
      push("response_item", startMs, { type: kind, call_id: callId, name: "shell", input: "ls" });
      push("response_item", endMs, { type: `${kind}_output`, call_id: callId, output: "ok" });
    },
    write(): void {
      writeFileSync(this.path, `${lines.join("\n")}\n`);
    },
    cleanup(): void {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
