/**
 * Regression tests for the dsh decode accounting.
 *
 * They build a real session store on disk (multi-frame zstd, exactly how dsh
 * writes it) instead of poking at internals, so the frame splitting, the
 * incremental cursor, the chunk-record expansion and the aggregation are all
 * exercised together.
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { readDshUsage } from "./dsh-usage.ts";
import { newSession, step, T0, type Event } from "./dsh-fixture.ts";

test("一轮多个 step 求和，TTFT 与工具时间都不进解码分母", () => {
  const s = newSession();
  try {
    const events: Event[] = [s.event("turn/start", T0, { turn: 1 })];
    events.push(
      ...step(s, {
        turn: 1,
        step: 1,
        output: 100,
        startAt: T0,
        firstChunkAt: T0 + 1_000,
        endAt: T0 + 2_000,
        thinkMs: 600,
      }),
    );
    // 10s of tool wall clock inside the turn: it must not slow the rate down.
    events.push(s.event("tool/call", T0 + 2_000, { callId: "c1" }));
    events.push(s.event("tool/result", T0 + 12_000, { message: { source: { callId: "c1" } } }));
    events.push(
      ...step(s, {
        turn: 1,
        step: 2,
        output: 200,
        startAt: T0 + 12_000,
        firstChunkAt: T0 + 12_500,
        endAt: T0 + 14_000,
        thinkMs: 900,
      }),
    );
    events.push(s.event("turn/end", T0 + 14_000, { turn: 1 }));
    writeFileSync(s.path, s.frame(events));

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage);
    assert.deepEqual(usage.turnSpeed, {
      turn: 1,
      output: 300,
      modelMs: 4_000,
      ttftMs: 1_500,
      decodeMs: 2_500,
      samples: 2,
      tokensPerSecond: 120,
      // 600 + 900 of thinking; the rest of the 2500ms decode window is output.
      thinkMs: 1_500,
      outMs: 1_000,
    });
    assert.equal(usage.speed?.turns, 1);
    assert.equal(usage.speed?.steps, 2);
    assert.equal(usage.speed?.modelMs, 4_000);
    assert.equal(usage.speed?.toolMs, 10_000);
    assert.equal(usage.speed?.ttftAvgMs, 750);
    assert.equal(usage.speed?.tokensPerSecond, 120);
    assert.equal(usage.speed?.thinkMs, 1_500);
    assert.equal(usage.speed?.outMs, 1_000);
  } finally {
    s.cleanup();
  }
});

test("生成 = 思考 + 输出；全无思考记录的会话给 null 而不是 0", () => {
  const s = newSession();
  try {
    const events: Event[] = [
      s.event("turn/start", T0, { turn: 1 }),
      ...step(s, {
        turn: 1,
        step: 1,
        output: 500,
        startAt: T0,
        firstChunkAt: T0,
        endAt: T0 + 2_000,
        thinkMs: 1_200,
      }),
      // A second call that never streamed thinking at all (no reasoning record).
      ...step(s, {
        turn: 1,
        step: 2,
        output: 300,
        startAt: T0 + 2_000,
        firstChunkAt: T0 + 2_000,
        endAt: T0 + 3_000,
        thinking: false,
      }),
      s.event("turn/end", T0 + 3_000, { turn: 1 }),
    ];
    writeFileSync(s.path, s.frame(events));

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage?.speed);
    assert.equal(usage.speed.decodeMs, 3_000);
    // Only step 1 had reasoning, so thinking is 1200ms and output is the rest.
    assert.equal(usage.speed.thinkMs, 1_200);
    assert.equal(usage.speed.outMs, 1_800);
    assert.equal((usage.speed.thinkMs ?? 0) + (usage.speed.outMs ?? 0), usage.speed.decodeMs);
  } finally {
    s.cleanup();
  }
});

test("一次思考记录都没有时，思考/输出都是 null（不编 0）", () => {
  const s = newSession();
  try {
    const events: Event[] = [
      s.event("turn/start", T0, { turn: 1 }),
      ...step(s, {
        turn: 1,
        step: 1,
        output: 500,
        startAt: T0,
        firstChunkAt: T0,
        endAt: T0 + 2_000,
        thinking: false,
      }),
      s.event("turn/end", T0 + 2_000, { turn: 1 }),
    ];
    writeFileSync(s.path, s.frame(events));

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage?.speed);
    assert.equal(usage.speed.decodeMs, 2_000);
    assert.equal(usage.speed.thinkMs, null);
    assert.equal(usage.speed.outMs, null);
    assert.equal(usage.turnSpeed?.thinkMs, null);
    assert.equal(usage.turnSpeed?.outMs, null);
  } finally {
    s.cleanup();
  }
});

test("没 stream 的调用不给 TTFT/decode 样本，但它的 output 仍进总量", () => {
  const s = newSession();
  try {
    const events: Event[] = [
      s.event("turn/start", T0, { turn: 1 }),
      ...step(s, {
        turn: 1,
        step: 1,
        output: 100,
        startAt: T0,
        firstChunkAt: T0 + 1_000,
        endAt: T0 + 2_000,
      }),
      // The request failed (or predates chunk capture): no first-token instant,
      // so it must not be counted as a zero that drags the average down.
      ...step(s, {
        turn: 1,
        step: 2,
        output: 5_000,
        startAt: T0 + 2_000,
        firstChunkAt: T0 + 3_000,
        endAt: T0 + 4_000,
        stream: false,
      }),
      s.event("turn/end", T0 + 4_000, { turn: 1 }),
    ];
    writeFileSync(s.path, s.frame(events));

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage);
    assert.equal(usage.turnSpeed?.samples, 1);
    assert.equal(usage.turnSpeed?.ttftMs, 1_000);
    assert.equal(usage.turnSpeed?.decodeMs, 1_000);
    // modelMs is TTFT + decode, so the un-sampled call contributes nothing.
    assert.equal(usage.turnSpeed?.modelMs, 2_000);
    assert.equal(usage.turnSpeed?.output, 5_100);
    assert.equal(usage.turnSpeed?.tokensPerSecond, 5_100);
  } finally {
    s.cleanup();
  }
});

test("旧格式：逐条 assistant/chunk 事件也能定出首末 chunk", () => {
  const s = newSession(3);
  try {
    const events: Event[] = [
      s.event("turn/start", T0, { turn: 1 }),
      s.event("step/start", T0, { turn: 1, step: 1 }),
      s.event("assistant/chunk", T0 + 1_000, { turn: 1, step: 1 }),
      s.event("assistant/chunk", T0 + 1_400, { turn: 1, step: 1 }),
      s.event("assistant/message", T0 + 1_500, {
        turn: 1,
        step: 1,
        usage: { outputTokens: 200 },
      }),
      s.event("turn/end", T0 + 1_500, { turn: 1 }),
    ];
    writeFileSync(s.path, s.frame(events));

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage);
    assert.equal(usage.turnSpeed?.ttftMs, 1_000);
    assert.equal(usage.turnSpeed?.decodeMs, 400);
    assert.equal(usage.turnSpeed?.samples, 1);
    assert.equal(usage.turnSpeed?.tokensPerSecond, 500);
  } finally {
    s.cleanup();
  }
});

test("重试：同一 turn:step 只按最高 seq 计一次", () => {
  const s = newSession();
  try {
    const events: Event[] = [
      s.event("turn/start", T0, { turn: 1 }),
      s.event("step/start", T0, { turn: 1, step: 1 }),
      s.event("assistant/message", T0 + 1_000, {
        turn: 1,
        step: 1,
        usage: { outputTokens: 100 },
        stream: [{ type: "chunk", time: T0 + 100, chunk: { type: "finish" } }],
      }),
      // The retry lands later with a higher seq; it replaces, never adds to, the
      // first attempt.
      s.event("assistant/message", T0 + 1_200, {
        turn: 1,
        step: 1,
        usage: { outputTokens: 100 },
        stream: [
          { type: "chunk", time: T0 + 200, chunk: { type: "block-start" } },
          { type: "chunk", time: T0 + 1_200, chunk: { type: "finish" } },
        ],
      }),
      s.event("turn/end", T0 + 1_200, { turn: 1 }),
    ];
    writeFileSync(s.path, s.frame(events));

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage);
    assert.equal(usage.turnSpeed?.output, 100);
    // dsh first-wins on the first chunk: the (earlier) abandoned attempt still
    // anchors TTFT, while the latest chunk closes the decode window.
    assert.equal(usage.turnSpeed?.ttftMs, 100);
    assert.equal(usage.turnSpeed?.decodeMs, 1_100);
    assert.equal(usage.totals?.output, 100);
  } finally {
    s.cleanup();
  }
});

test("全会话汇总与轮/步计数", () => {
  const s = newSession();
  try {
    const events: Event[] = [
      s.event("turn/start", T0, { turn: 1 }),
      ...step(s, {
        turn: 1,
        step: 1,
        output: 600,
        startAt: T0,
        firstChunkAt: T0 + 1_000,
        endAt: T0 + 7_000,
      }),
      s.event("turn/end", T0 + 7_000, { turn: 1 }),
      s.event("turn/start", T0 + 7_000, { turn: 2 }),
      ...step(s, {
        turn: 2,
        step: 1,
        output: 60,
        startAt: T0 + 7_000,
        firstChunkAt: T0 + 8_000,
        endAt: T0 + 68_000,
      }),
      s.event("turn/end", T0 + 68_000, { turn: 2 }),
    ];
    writeFileSync(s.path, s.frame(events));

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage?.speed);
    assert.equal(usage.speed.turns, 2);
    assert.equal(usage.speed.steps, 2);
    assert.equal(usage.speed.output, 660);
    // decode = 6s (turn 1) + 60s (turn 2); TTFT is 1s + 1s and is NOT in it.
    assert.equal(usage.speed.decodeMs, 66_000);
    assert.equal(usage.speed.ttftMs, 2_000);
    assert.equal(usage.speed.ttftAvgMs, 1_000);
    assert.equal(usage.speed.tokensPerSecond, 10);
    assert.equal(usage.turnSpeed?.turn, 2);
    assert.equal(usage.turnSpeed?.tokensPerSecond, 1);
  } finally {
    s.cleanup();
  }
});

test("新一轮落在追加的 frame 里也能读到（增量解码）", () => {
  const s = newSession();
  try {
    writeFileSync(
      s.path,
      s.frame([
        s.event("turn/start", T0, { turn: 1 }),
        ...step(s, {
          turn: 1,
          step: 1,
          output: 100,
          startAt: T0,
          firstChunkAt: T0,
          endAt: T0 + 1_000,
        }),
        s.event("turn/end", T0 + 1_000, { turn: 1 }),
      ]),
    );
    assert.equal(readDshUsage(s.sessionId, s.home)?.speed?.turns, 1);

    appendFileSync(
      s.path,
      s.frame([
        s.event("turn/start", T0 + 1_000, { turn: 2 }),
        ...step(s, {
          turn: 2,
          step: 1,
          output: 200,
          startAt: T0 + 1_000,
          firstChunkAt: T0 + 1_000,
          endAt: T0 + 2_000,
        }),
        s.event("turn/end", T0 + 2_000, { turn: 2 }),
      ]),
    );

    const usage = readDshUsage(s.sessionId, s.home);
    assert.ok(usage?.speed);
    assert.equal(usage.speed.turns, 2);
    assert.equal(usage.speed.output, 300);
    assert.equal(usage.speed.decodeMs, 2_000);
    assert.equal(usage.speed.tokensPerSecond, 150);
    assert.equal(usage.turnSpeed?.turn, 2);
  } finally {
    s.cleanup();
  }
});

test("会话目录里同时有多个存储版本时取版本号最高的", () => {
  const s = newSession(4);
  try {
    writeFileSync(
      s.path,
      s.frame([
        ...step(s, {
          turn: 1,
          step: 1,
          output: 111,
          startAt: T0,
          firstChunkAt: T0,
          endAt: T0 + 1_000,
        }),
      ]),
    );
    const v5 = s.path.replace("session.v4.", "session.v5.");
    writeFileSync(
      v5,
      s.frame([
        ...step(s, {
          turn: 1,
          step: 1,
          output: 999,
          startAt: T0,
          firstChunkAt: T0,
          endAt: T0 + 1_000,
        }),
      ]),
    );

    assert.equal(readDshUsage(s.sessionId, s.home)?.speed?.output, 999);
  } finally {
    s.cleanup();
  }
});
