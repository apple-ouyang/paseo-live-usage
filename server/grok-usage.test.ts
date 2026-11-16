/**
 * Regression tests for the Grok adapter.
 *
 * They build a real `~/.grok/sessions/<cwd>/<sid>/` tree (events timeline plus
 * the CLI's `usage.json` ledger) and go through `collectUsage`, so the phase
 * interval building, the turn-number mapping and the ledger match are exercised
 * together.
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collectUsage } from "./collect.ts";
import { grokLedger, newGrokSession, T0 } from "./grok-fixture.ts";

function snapshot(s: ReturnType<typeof newGrokSession>) {
  s.writeEvents();
  const usage = collectUsage("test-agent", {
    provider: "grok",
    sessionId: s.sessionId,
    lastUsage: null,
    home: s.home,
  });
  assert.ok(usage, "collectUsage produced no grok snapshot");
  return usage;
}

test("单轮：相位给出等待/思考/输出/工具，账本给出 token、命中率与真实花费", () => {
  const s = newGrokSession();
  try {
    s.turnStarted(0, T0);
    s.loopStarted(T0 + 100);
    s.phase("waiting_for_model", T0 + 100);
    s.phase("streaming_reasoning", T0 + 1_000);
    // Grok repeats the current phase once per chunk; it must not restart the span.
    s.phase("streaming_reasoning", T0 + 2_000);
    s.phase("streaming_text", T0 + 4_000);
    s.toolStarted("read_file", T0 + 5_000);
    s.phase("tool_execution", T0 + 5_000);
    s.toolCompleted("read_file", T0 + 7_000, 2_000);
    s.phase("streaming_text", T0 + 7_000);
    s.turnEnded(T0 + 8_000);
    s.writeUsage(
      grokLedger(
        [
          {
            turnNumber: 1,
            endedAt: T0 + 8_000,
            promptTokens: 10_000, // full prompt: the cache sits inside it
            cacheRead: 9_000,
            output: 500,
            reasoning: 200,
            calls: 2,
          },
        ],
        2_500_000_000, // ticks: 10^10 per USD
      ),
    );

    const usage = snapshot(s);
    assert.equal(usage.source, "grok-session");
    assert.equal(usage.inFlight, false);
    assert.deepEqual(usage.speed, {
      output: 500,
      ttftMs: 1_000,
      decodeMs: 5_000,
      samples: 1,
      // 500 tokens over the 5s generation window.
      tokensPerSecond: 100,
      thinkMs: 3_000,
      outMs: 2_000,
      turns: 1,
      steps: 2,
      modelMs: 6_000,
      toolMs: 2_000,
      ttftAvgMs: 1_000,
    });
    assert.deepEqual(usage.turnSpeed, {
      turn: 0,
      output: 500,
      ttftMs: 1_000,
      decodeMs: 5_000,
      samples: 1,
      tokensPerSecond: 100,
      thinkMs: 3_000,
      outMs: 2_000,
      modelMs: 6_000,
    });
    // 等待首字 + 生成 + 工具 must equal the turn span.
    assert.equal(usage.speed!.ttftMs + usage.speed!.decodeMs + usage.speed!.toolMs, 8_000);
    assert.equal(usage.speed!.thinkMs! + usage.speed!.outMs!, usage.speed!.decodeMs);

    // The ledger's inputTokens is the full prompt (10000, cache inside it);
    // the adapter reports the fresh part and the same hit rate as everyone else.
    assert.equal(usage.totals?.input, 1_000);
    assert.equal(usage.totals?.cacheRead, 9_000);
    assert.equal(usage.totals?.output, 500);
    assert.equal(usage.totals?.reasoning, 200);
    assert.equal(usage.totals?.hitPct, 90);
    assert.deepEqual(usage.cost, { value: 0.25, currency: "USD" });
    assert.equal(usage.last?.output, 500);
    assert.equal(usage.last?.endedAt, T0 + 8_000);
  } finally {
    s.cleanup();
  }
});

test("进行中的轮次：账本还没有它，就不进 speed，只进回退行的总时长", () => {
  const s = newGrokSession();
  try {
    s.turnStarted(0, T0);
    s.loopStarted(T0 + 100);
    s.phase("waiting_for_model", T0 + 100);
    s.phase("streaming_reasoning", T0 + 1_000);
    s.phase("streaming_text", T0 + 4_000);
    // No turn_ended, no ledger row yet.

    const usage = snapshot(s);
    assert.equal(usage.inFlight, true);
    assert.equal(usage.speed, null);
    // The newest turn still supplies 本轮, but without a rate it cannot be measured.
    assert.equal(usage.turnSpeed?.turn, 0);
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
    assert.equal(usage.turnSpeed?.thinkMs, 3_000);
    assert.equal(usage.totals, null);
    assert.equal(usage.cost, null);
    assert.ok(usage.timing);
    assert.equal(usage.timing.totalMs, 4_000);
    assert.equal(usage.timing.toolMs, 0);
    assert.equal(usage.timing.requestMs, 4_000);
  } finally {
    s.cleanup();
  }
});

test("已结束但没有账本行的轮次不进 speed（分子分母必须同源）", () => {
  const s = newGrokSession();
  try {
    s.turnStarted(0, T0);
    s.loopStarted(T0 + 100);
    s.phase("waiting_for_model", T0 + 100);
    s.phase("streaming_reasoning", T0 + 1_000);
    s.turnEnded(T0 + 5_000);
    s.writeUsage(grokLedger([]));

    const usage = snapshot(s);
    assert.equal(usage.inFlight, false);
    assert.equal(usage.speed, null);
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
    // The measured span is still reported by the fallback row.
    assert.equal(usage.timing?.totalMs, 5_000);
  } finally {
    s.cleanup();
  }
});

test("账本有 reasoning token 但相位没有思考流：思考与速率都 null，不编 0", () => {
  const s = newGrokSession();
  try {
    s.turnStarted(0, T0);
    s.loopStarted(T0 + 100);
    s.phase("waiting_for_model", T0 + 100);
    s.phase("streaming_text", T0 + 2_000);
    s.turnEnded(T0 + 4_000);
    s.writeUsage(
      grokLedger([
        { turnNumber: 1, endedAt: T0 + 4_000, promptTokens: 2_000, cacheRead: 1_500, output: 300, reasoning: 250 },
      ]),
    );

    const usage = snapshot(s);
    assert.equal(usage.speed?.output, 300);
    assert.equal(usage.speed?.decodeMs, 2_000);
    assert.equal(usage.speed?.thinkMs, null);
    assert.equal(usage.speed?.outMs, null);
    // The reasoning tokens were not covered by any measured window.
    assert.equal(usage.speed?.tokensPerSecond, null);
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
  } finally {
    s.cleanup();
  }
});

test("账本的轮号是事件轮号 +1；对不上时宁可当作没有 token", () => {
  const s = newGrokSession();
  try {
    s.turnStarted(7, T0);
    s.loopStarted(T0 + 100);
    s.phase("waiting_for_model", T0 + 100);
    s.phase("streaming_text", T0 + 1_000);
    s.turnEnded(T0 + 3_000);
    // Right number, wrong end time: the mapping must not be trusted blindly.
    s.writeUsage(
      grokLedger([{ turnNumber: 8, endedAt: T0 + 900_000, promptTokens: 100, cacheRead: 90, output: 40 }]),
    );

    const usage = snapshot(s);
    assert.equal(usage.turnSpeed?.output, 0);
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
    assert.equal(usage.speed, null);
    // The session ledger is still the CLI's own totals.
    assert.equal(usage.totals?.output, 40);
  } finally {
    s.cleanup();
  }
});

test("多轮：只有已记账的轮次进 speed，轮/步来自账本", () => {
  const s = newGrokSession();
  try {
    // Turn 0 settles with tokens.
    s.turnStarted(0, T0);
    s.loopStarted(T0 + 100);
    s.phase("waiting_for_model", T0 + 100);
    s.phase("streaming_reasoning", T0 + 1_000);
    s.phase("streaming_text", T0 + 3_000);
    s.turnEnded(T0 + 4_000);
    // Turn 1 is still running and has no ledger row.
    s.turnStarted(1, T0 + 100_000);
    s.loopStarted(T0 + 100_100);
    s.phase("waiting_for_model", T0 + 100_100);
    s.phase("streaming_reasoning", T0 + 101_000);

    s.writeUsage(
      grokLedger([
        { turnNumber: 1, endedAt: T0 + 4_000, promptTokens: 2_000, cacheRead: 1_900, output: 600, reasoning: 100, calls: 3 },
      ]),
    );

    const usage = snapshot(s);
    assert.equal(usage.inFlight, true);
    // Only the settled turn counts towards the rate.
    assert.equal(usage.speed?.turns, 1);
    assert.equal(usage.speed?.steps, 3);
    assert.equal(usage.speed?.output, 600);
    assert.equal(usage.speed?.decodeMs, 3_000);
    assert.equal(usage.speed?.tokensPerSecond, 200);
    assert.equal(usage.speed?.ttftMs, 1_000);
    // The running turn is what 本轮 shows, with its rate unknown.
    assert.equal(usage.turnSpeed?.turn, 1);
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
    assert.equal(usage.speed!.ttftMs + usage.speed!.decodeMs + usage.speed!.toolMs, 4_000);
  } finally {
    s.cleanup();
  }
});

test("会话目录按 URL 编码的 cwd 分层，也能被找到", () => {
  const s = newGrokSession();
  try {
    s.turnStarted(0, T0);
    s.loopStarted(T0 + 10);
    s.phase("waiting_for_model", T0 + 10);
    s.phase("streaming_text", T0 + 500);
    s.turnEnded(T0 + 1_000);
    s.writeUsage(grokLedger([{ turnNumber: 1, endedAt: T0 + 1_000, promptTokens: 100, cacheRead: 80, output: 10 }]));

    const usage = snapshot(s);
    assert.ok(usage.last);
    // 80 / (20 + 80) — a hit rate only, no cache subtraction.
    assert.equal(usage.last.hitPct, 80);
    // No usage.json regression: the directory is found by scanning one level.
    assert.equal(usage.speed?.output, 10);
  } finally {
    s.cleanup();
  }
});

test("账本 inputTokens 是完整 prompt：新鲜 input 减掉 cache，命中率与别家同一分母", () => {
  const s = newGrokSession();
  try {
    s.turnStarted(0, T0);
    s.loopStarted(T0 + 10);
    s.phase("waiting_for_model", T0 + 10);
    s.phase("streaming_text", T0 + 500);
    s.turnEnded(T0 + 1_000);
    s.writeUsage(
      grokLedger([
        { turnNumber: 1, endedAt: T0 + 1_000, promptTokens: 100_000, cacheRead: 94_000, output: 1_000 },
      ]),
    );

    // Guard the fixture itself against drifting away from the real file: every
    // real usage.json on this machine satisfies exactly this identity, and it is
    // only true while the cache sits inside `inputTokens`.
    const raw = JSON.parse(readFileSync(s.usagePath, "utf8")) as {
      session: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    assert.equal(raw.session.totalTokens, raw.session.inputTokens + raw.session.outputTokens);

    const usage = snapshot(s);
    // 100000 - 94000 fresh input, and 94000/100000 — not 94000/(100000+94000).
    assert.equal(usage.totals?.input, 6_000);
    assert.equal(usage.totals?.cacheRead, 94_000);
    assert.equal(usage.totals?.hitPct, 94);
    assert.equal(usage.last?.input, 6_000);
    assert.equal(usage.last?.hitPct, 94);
  } finally {
    s.cleanup();
  }
});
