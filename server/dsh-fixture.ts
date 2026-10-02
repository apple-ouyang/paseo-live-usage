/**
 * A real dsh session store in a throwaway HOME, for the tests.
 *
 * The log is a concatenation of independent zstd frames exactly like dsh writes
 * it, and the settlement events carry the V3 compact stream (`time0` + per-delta
 * `dt`), so anything built on this fixture exercises the real parser instead of
 * a mock. Lives outside `*.test.ts` so more than one test file can use it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

/** A fixed epoch so every assertion can be an exact number. */
export const T0 = 1_790_000_000_000;

export type Event = { type: string; seq: number; time: number; data: unknown };

export function newSession(version = 4) {
  const home = mkdtempSync(join(tmpdir(), "live-usage-"));
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const dir = join(home, ".dsh", "sessions", "--test--", sessionId);
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  return {
    home,
    sessionId,
    path: join(dir, `session.v${version}.jsonl.zstd`),
    event(type: string, time: number, data: unknown = {}): Event {
      seq += 1;
      return { type, seq, time, data };
    },
    /** One zstd frame per call — the log is a concatenation of frames. */
    frame(events: Event[]): Buffer {
      return zlib.zstdCompressSync(
        Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join("")),
      );
    },
    cleanup(): void {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * One model call: `startAt` -> message landed, with the first streamed chunk at
 * `firstChunkAt`. `thinkMs` splits the decode window into a reasoning record plus
 * a visible-text record; `thinking: false` omits the reasoning record entirely
 * (a model that never streams thinking).
 */
export function step(
  s: ReturnType<typeof newSession>,
  input: {
    turn: number;
    step: number;
    output: number;
    startAt: number;
    firstChunkAt: number;
    endAt: number;
    thinkMs?: number;
    thinking?: boolean;
    /** Omit the embedded stream, as a failed/pre-chunk call does. */
    stream?: boolean;
  },
): Event[] {
  const decodeMs = input.endAt - input.firstChunkAt;
  const thinking = input.thinking ?? true;
  const thinkMs = thinking ? Math.min(decodeMs, input.thinkMs ?? decodeMs) : 0;
  const outMs = decodeMs - thinkMs;
  const data: Record<string, unknown> = {
    turn: input.turn,
    step: input.step,
    usage: { inputTokens: 10, outputTokens: input.output, cacheReadTokens: 90 },
  };
  if (input.stream !== false) {
    const stream: unknown[] = [];
    if (thinking) {
      stream.push(
        {
          type: "chunk",
          time: input.firstChunkAt,
          chunk: { type: "block-start", blockType: "reasoning" },
        },
        {
          type: "reasoning-chunks",
          time0: input.firstChunkAt,
          index: 0,
          dt: [0, thinkMs],
          texts: ["a", "b"],
        },
      );
    }
    if (outMs > 0) {
      const textAt = input.firstChunkAt + thinkMs;
      stream.push(
        { type: "chunk", time: textAt, chunk: { type: "block-start", blockType: "text" } },
        { type: "text-chunks", time0: textAt, index: 1, dt: [0, outMs], texts: ["c", "d"] },
      );
    }
    stream.push({ type: "chunk", time: input.endAt, chunk: { type: "finish" } });
    data.stream = stream;
  }
  return [
    s.event("step/start", input.startAt, { turn: input.turn, step: input.step }),
    s.event("assistant/message", input.endAt, data),
  ];
}
