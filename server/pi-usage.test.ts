/**
 * Regression tests for the pi adapter's "which call is `last`" rule.
 *
 * 2026-11-12 实测：用户中断后 pi 落了一行 `stopReason: "aborted"` 的 assistant 消息，
 * usage 全为 0。插件把它当成最后一次调用，于是胶囊上的 t/s 和命中率同时消失，只剩
 * 会话命中率（截图里的「95%」）。空结算不是一次测量，不能覆盖 `last`。
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectUsage } from "./collect.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

function assistant(at: string, usage: Usage, stopReason = "toolUse"): object {
  return {
    type: "message",
    id: `m-${at}`,
    timestamp: at,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { ...usage, totalTokens: usage.input + usage.cacheRead + usage.output },
      stopReason,
      timestamp: Date.parse(at),
    },
  };
}

function user(at: string): object {
  return {
    type: "message",
    id: `u-${at}`,
    timestamp: at,
    message: { role: "user", content: [{ type: "text", text: "go" }] },
  };
}

/** A throwaway HOME holding one pi session plus the statusline samples file. */
function newHome(entries: object[], samples: object[]): { home: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), "live-usage-pi-usage-"));
  const dir = join(home, ".pi", "agent", "sessions", "cwd");
  mkdirSync(dir, { recursive: true });
  const header = { type: "session", id: SESSION_ID, timestamp: "2026-11-12T02:30:00.000Z" };
  const path = join(dir, `2026-11-12T02-30-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(path, `${[header, ...entries].map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(
    join(home, ".pi", "agent", "statusline-samples.jsonl"),
    `${samples.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("中断落盘的空结算不覆盖 last：胶囊仍有 t/s 与命中率", () => {
  const h = newHome(
    [
      user("2026-11-12T02:39:00.000Z"),
      assistant("2026-11-12T02:39:12.000Z", {
        input: 265,
        cacheRead: 149_504,
        cacheWrite: 0,
        output: 140,
        reasoning: 85,
      }),
      // The abort: pi still writes a settlement, with every token bucket at 0.
      assistant(
        "2026-11-12T02:39:47.097Z",
        { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        "aborted",
      ),
    ],
    [{ session: SESSION_ID, t: Date.parse("2026-11-12T02:39:12.000Z"), ttftMs: 14_000, decodeMs: 5_000, thinkMs: 600, outMs: 4_400, out: 140 }],
  );
  try {
    const snap = collectUsage("agent", {
      provider: "pi",
      sessionId: SESSION_ID,
      lastUsage: null,
      running: false,
      home: h.home,
    });
    assert.ok(snap);
    assert.equal(snap.last?.output, 140);
    assert.ok((snap.last?.tokensPerSecond ?? 0) > 0);
    assert.ok((snap.last?.hitPct ?? 0) > 99);
    // The abort is not a step either.
    assert.equal(snap.speed?.steps, 1);
    // ... and it does not zero the session hit rate.
    assert.ok((snap.totals?.hitPct ?? 0) > 99);
  } finally {
    h.cleanup();
  }
});

test("胶囊读最近一次采样的解码速度，不是含首字等待的请求墙钟", () => {
  const h = newHome(
    [
      user("2026-11-12T02:38:00.000Z"),
      assistant("2026-11-12T02:38:19.000Z", {
        input: 300,
        cacheRead: 100_000,
        cacheWrite: 0,
        output: 120,
        reasoning: 40,
      }),
      user("2026-11-12T02:39:00.000Z"),
      assistant("2026-11-12T02:39:19.000Z", {
        input: 265,
        cacheRead: 149_504,
        cacheWrite: 0,
        output: 700,
        reasoning: 100,
      }),
    ],
    [
      { session: SESSION_ID, t: Date.parse("2026-11-12T02:38:19.000Z"), ttftMs: 15_000, decodeMs: 4_000, out: 120 },
      // Newest call: 700 tokens in a 5s decode window = 140 t/s, with a 14s wait.
      { session: SESSION_ID, t: Date.parse("2026-11-12T02:39:19.000Z"), ttftMs: 14_000, decodeMs: 5_000, thinkMs: 600, outMs: 4_400, out: 700 },
    ],
  );
  try {
    const snap = collectUsage("agent", {
      provider: "pi",
      sessionId: SESSION_ID,
      lastUsage: null,
      running: false,
      home: h.home,
    });
    assert.ok(snap);
    assert.equal(snap.speed?.latest?.tokensPerSecond, 140);
    assert.equal(snap.speed?.latest?.ttftMs, 14_000);
    assert.equal(snap.speed?.latest?.output, 700);
    // The session file's own wall clock for the same call would read 700 / 19s.
    assert.ok((snap.last?.tokensPerSecond ?? 0) < 40);
  } finally {
    h.cleanup();
  }
});

test("没有任何采样行时 latest 是 null，不退回到会话墙钟冒充实测", () => {
  const h = newHome(
    [
      user("2026-11-12T02:39:00.000Z"),
      assistant("2026-11-12T02:39:19.000Z", {
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 20,
        reasoning: 0,
      }),
    ],
    [],
  );
  try {
    const snap = collectUsage("agent", {
      provider: "pi",
      sessionId: SESSION_ID,
      lastUsage: null,
      running: false,
      home: h.home,
    });
    assert.ok(snap);
    assert.equal(snap.speed, null);
    assert.ok((snap.last?.tokensPerSecond ?? 0) > 0);
  } finally {
    h.cleanup();
  }
});
