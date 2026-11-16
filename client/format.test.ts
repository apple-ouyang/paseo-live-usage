/**
 * The pill label: newest measured numbers only, totals stay in the popover.
 *
 * 2026-11-12 实测的回归：一次中断之后 `last` 是一次「空结算」（tokens 全 0、命中率
 * 无法计算），旧版标签因此只剩会话命中率「95%」，速度和首字都消失。
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveUsageResult } from "../shared/rpc.ts";
import { fmtHit, pillLabel } from "./format.ts";

/** Minimal supported payload; every field the label reads is set per test. */
function payload(patch: Record<string, unknown>): LiveUsageResult {
  return {
    supported: true,
    provider: "pi",
    sessionId: "sid",
    source: "pi-session",
    observedAt: Date.now(),
    sourceAgeMs: 0,
    inFlight: false,
    last: null,
    totals: null,
    context: null,
    cost: null,
    timing: null,
    ...patch,
  } as unknown as LiveUsageResult;
}

test("最新采样：t/s + 首字（命中率不上胶囊）", () => {
  const label = pillLabel(
    payload({
      last: {
        turn: null,
        step: null,
        output: 700,
        reasoning: 100,
        input: 265,
        cacheRead: 149_504,
        cacheWrite: 0,
        stepMs: 19_000,
        tokensPerSecond: 36.8,
        hitPct: 99.99,
        endedAt: Date.now(),
      },
      speed: {
        output: 700,
        ttftMs: 14_000,
        decodeMs: 5_000,
        samples: 1,
        tokensPerSecond: 140,
        thinkMs: 600,
        outMs: 4_400,
        turns: 1,
        steps: 1,
        modelMs: 19_000,
        toolMs: 0,
        ttftAvgMs: 14_000,
        latest: {
          ttftMs: 14_000,
          decodeMs: 5_000,
          output: 700,
          tokensPerSecond: 140,
          at: Date.now(),
          thinkMs: 600,
        },
      },
    }),
  );
  assert.equal(label, "140 t/s · 首字 14s");
});

test("中断后的空结算不会再把 t/s 和首字从胶囊上抹掉", () => {
  const label = pillLabel(
    payload({
      // The aborted settlement: no tokens, so no hit rate was measurable.
      last: {
        turn: null,
        step: null,
        output: 0,
        reasoning: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        stepMs: 100,
        tokensPerSecond: null,
        hitPct: null,
        endedAt: Date.now(),
      },
      totals: {
        input: 1_000,
        cacheRead: 19_000,
        cacheWrite: 0,
        output: 2_000,
        hitPct: 95,
      },
      speed: {
        output: 2_000,
        ttftMs: 20_000,
        decodeMs: 10_000,
        samples: 4,
        tokensPerSecond: 200,
        thinkMs: 1_000,
        outMs: 9_000,
        turns: 2,
        steps: 4,
        modelMs: 30_000,
        toolMs: 0,
        ttftAvgMs: 5_000,
        latest: {
          ttftMs: 5_000,
          decodeMs: 2_500,
          output: 350,
          tokensPerSecond: 140,
          at: Date.now(),
          thinkMs: 200,
        },
      },
    }),
  );
  assert.equal(label, "140 t/s · 首字 5.0s");
});

test("没有样本的 provider 退回单次调用墙钟，不加编造的首字与命中率", () => {
  const label = pillLabel(
    payload({
      last: {
        turn: null,
        step: null,
        output: 400,
        reasoning: 0,
        input: 100,
        cacheRead: 900,
        cacheWrite: 0,
        stepMs: 4_000,
        tokensPerSecond: 100,
        hitPct: 90,
        endedAt: Date.now(),
      },
    }),
  );
  assert.equal(label, "100 t/s");
});

test("最近一次采样的解码窗口太短时，退到会话解码速度而不是含首字的墙钟", () => {
  const label = pillLabel(
    payload({
      last: {
        turn: null,
        step: null,
        output: 66,
        reasoning: 0,
        input: 200,
        cacheRead: 90_000,
        cacheWrite: 0,
        stepMs: 8_149,
        tokensPerSecond: 8.1,
        hitPct: 96,
        endedAt: Date.now(),
      },
      speed: {
        output: 5_000,
        ttftMs: 60_000,
        decodeMs: 25_000,
        samples: 12,
        tokensPerSecond: 200,
        thinkMs: 5_000,
        outMs: 20_000,
        turns: 3,
        steps: 12,
        modelMs: 85_000,
        toolMs: 0,
        ttftAvgMs: 5_000,
        latest: {
          ttftMs: 7_923,
          decodeMs: 219,
          output: 66,
          tokensPerSecond: null,
          at: Date.now(),
          thinkMs: 0,
        },
      },
    }),
  );
  assert.equal(label, "200 t/s · 首字 7.9s");
});

test("命中率不把 99.8 抖成 100", () => {
  assert.equal(fmtHit(99.82), "99.8");
  assert.equal(fmtHit(99.999), "99.9");
  assert.equal(fmtHit(96.4), "96");
  assert.equal(fmtHit(7.25), "7.3");
  assert.equal(fmtHit(null), null);
});

test("没有速度也没有命中率时退回上下文占用，不支持时是「–」", () => {
  assert.equal(
    pillLabel(payload({ context: { used: 120_000, window: 200_000, pressure: null } })),
    "60% ctx",
  );
  assert.equal(pillLabel({ supported: false, reason: "no usage source" }), "–");
  assert.equal(pillLabel(undefined), "…");
});
