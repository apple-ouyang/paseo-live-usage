/**
 * agy (antigravity-cli) adapter coverage: builds a REAL conversation db —
 * `~/.gemini/antigravity-cli/conversations/<conv>.db` with `steps` and
 * `gen_metadata` tables — plus the `~/.agy-acp-state/sessions.json` binding,
 * then runs the collect path. The protobuf blobs are hand-encoded with the
 * exact `exa.cortex_pb` / `exa.codeium_common_pb` field numbers agy writes.
 *
 *   node --test server/antigravity-usage.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { collectUsage } from "./collect.ts";
import { decodeGenMetadata } from "./antigravity-usage.ts";

/* ── minimal protobuf encoder (varint + length-delimited only) ────── */

function varint(n: number): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

function fVarint(field: number, value: number): number[] {
  return [...varint((field << 3) | 0), ...varint(value)];
}

function fBytes(field: number, bytes: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

function fString(field: number, value: string): number[] {
  return fBytes(field, [...new TextEncoder().encode(value)]);
}

function durationMsg(ms: number): number[] {
  const seconds = Math.floor(ms / 1000);
  const nanos = Math.round((ms - seconds * 1000) * 1_000_000);
  return [
    ...(seconds > 0 ? fVarint(1, seconds) : []),
    ...(nanos > 0 ? fVarint(2, nanos) : []),
  ];
}

function timestampMsg(epochMs: number): number[] {
  const seconds = Math.floor(epochMs / 1000);
  const nanos = Math.round((epochMs - seconds * 1000) * 1_000_000);
  return [
    ...(seconds > 0 ? fVarint(1, seconds) : []),
    ...(nanos > 0 ? fVarint(2, nanos) : []),
  ];
}

/**
 * `gen_metadata.data`: `CortexStepGeneratorMetadata`:
 *   - field 1: `ChatModelMetadata`:
 *     - field 4: `ModelUsageStats` {2 input_tokens (fresh), 3 output_tokens (total),
 *                                   4 cache_write_tokens, 5 cache_read_tokens,
 *                                   9 thinking_output_tokens, 10 response_output_tokens}
 *     - field 9: `ChatStartMetadata` {10: `ContextWindowMetadata` {1 estimated_tokens_used, 4 max_context_tokens}}
 *     - field 11: `time_to_first_token` (`Duration`)
 *     - field 12: `streaming_duration` (`Duration`)
 *     - field 17: `retry_infos` {2: `ModelUsageStats`}
 *     - field 19: `response_model`
 *   - field 2: `step_indices` (packed uint32)
 *   - field 4: `execution_id`
 */
export function genBlob(opts: {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cached?: number;
  thoughts?: number;
  responseOutput?: number;
  estimatedUsed?: number;
  ctx?: number;
  ttftMs?: number;
  decodeMs?: number;
  stepIndices?: number[];
  executionId?: string;
  slug?: string;
  /** Emit stats under field 17 instead of field 4 (fallback path). */
  statsAt17?: boolean;
  /** Corrupt the blob: append a dangling field tag with no value. */
  corrupt?: boolean;
}): Buffer {
  const input = opts.input ?? 1000;
  const thoughts = opts.thoughts ?? 0;
  const responseOutput = opts.responseOutput ?? ((opts.output ?? 50) - thoughts);
  const output = opts.output ?? (responseOutput + thoughts);
  const stats = [
    ...(input > 0 ? fVarint(2, input) : []),
    ...(output > 0 ? fVarint(3, output) : []),
    ...(opts.cacheWrite ? fVarint(4, opts.cacheWrite) : []),
    ...(opts.cached ? fVarint(5, opts.cached) : []),
    ...(thoughts > 0 ? fVarint(9, thoughts) : []),
    ...(responseOutput > 0 ? fVarint(10, responseOutput) : []),
  ];
  const ctxMeta = [
    ...(opts.estimatedUsed ? fVarint(1, opts.estimatedUsed) : []),
    ...(opts.ctx ? fVarint(4, opts.ctx) : []),
  ];
  const body = [
    ...(opts.statsAt17 ? fBytes(17, fBytes(2, stats)) : fBytes(4, stats)),
    ...(ctxMeta.length > 0 ? fBytes(9, fBytes(10, ctxMeta)) : []),
    ...(opts.ttftMs !== undefined ? fBytes(11, durationMsg(opts.ttftMs)) : []),
    ...(opts.decodeMs !== undefined ? fBytes(12, durationMsg(opts.decodeMs)) : []),
    ...fString(19, opts.slug ?? "gemini-4-argon"),
  ];
  if (opts.corrupt) body.push(...varint((99 << 3) | 0)); // tag without value
  const packedSteps = (opts.stepIndices ?? []).flatMap((idx) => varint(idx));
  const wrapper = [
    ...fBytes(1, body),
    ...(packedSteps.length > 0 ? fBytes(2, packedSteps) : []),
    ...(opts.executionId ? fString(4, opts.executionId) : []),
  ];
  return Buffer.from(wrapper);
}

export function stepMetaBlob(opts: {
  createdAt?: number;
  viewableAt?: number;
  finishedGeneratingAt?: number;
  completedAt?: number;
  startedAt?: number;
  executionId?: string;
  hasToolCall?: boolean;
}): Buffer {
  return Buffer.from([
    ...(opts.createdAt ? fBytes(1, timestampMsg(opts.createdAt)) : []),
    ...(opts.hasToolCall ? fBytes(4, fString(1, "tool")) : []),
    ...(opts.viewableAt ? fBytes(6, timestampMsg(opts.viewableAt)) : []),
    ...(opts.finishedGeneratingAt ? fBytes(7, timestampMsg(opts.finishedGeneratingAt)) : []),
    ...(opts.completedAt ? fBytes(8, timestampMsg(opts.completedAt)) : []),
    ...(opts.executionId ? fString(12, opts.executionId) : []),
    ...(opts.startedAt ? fBytes(32, timestampMsg(opts.startedAt)) : []),
  ]);
}

export function step15PayloadBlob(thinkingDurationMs?: number): Buffer {
  if (thinkingDurationMs === undefined) return Buffer.alloc(0);
  return Buffer.from(fBytes(20, fBytes(11, durationMsg(thinkingDurationMs))));
}

interface AgyFixture {
  home: string;
  sessionId: string;
  conversationId: string;
  cleanup(): void;
  addTurn(promptSteps: number, gens: Buffer[]): void;
  addStep(stepType: number, status: number, meta?: Buffer, payload?: Buffer): number;
  addGen(data: Buffer): number;
}

export function newAgySession(): AgyFixture {
  const home = mkdtempSync(join(tmpdir(), "agy-usage-"));
  const sessionId = "test-acp-session";
  const conversationId = "test-conv";
  mkdirSync(join(home, ".agy-acp-state"), { recursive: true });
  writeFileSync(
    join(home, ".agy-acp-state", "sessions.json"),
    JSON.stringify({ sessions: { [sessionId]: { conversationId } } }),
  );
  const convDir = join(home, ".gemini", "antigravity-cli", "conversations");
  mkdirSync(convDir, { recursive: true });
  const dbPath = join(convDir, `${conversationId}.db`);
  const mod = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  assert.ok(mod, "node:sqlite unavailable");
  const db: DatabaseSync = new mod.DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE steps (idx integer, step_type integer, status integer, metadata blob, step_payload blob, PRIMARY KEY (idx));" +
      "CREATE TABLE gen_metadata (idx integer, data blob, PRIMARY KEY (idx));",
  );
  const insStep = db.prepare(
    "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)",
  );
  const insGen = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
  let stepIdx = 0;
  let genIdx = 0;
  return {
    home,
    sessionId,
    conversationId,
    cleanup() {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
    addStep(stepType: number, status = 3, meta?: Buffer, payload?: Buffer): number {
      const cur = stepIdx++;
      insStep.run(cur, stepType, status, meta ?? null, payload ?? null);
      return cur;
    },
    addGen(data: Buffer): number {
      const cur = genIdx++;
      insGen.run(cur, data);
      return cur;
    },
    addTurn(promptSteps: number, gens: Buffer[]) {
      for (let i = 0; i < promptSteps; i++) {
        insStep.run(stepIdx++, 14, 3, null, null);
      }
      for (const g of gens) {
        insStep.run(stepIdx++, 15, 3, null, null);
        insGen.run(genIdx++, g);
      }
    },
  };
}

/* ── decoder unit coverage ────────────────────────────────────────── */

test("decodeGenMetadata 解出真实字段（含 TTFT、decodeMs、cacheWrite、contextWindowSize 与 slug）", () => {
  const g = decodeGenMetadata(
    0,
    genBlob({
      input: 4516,
      cached: 30000,
      cacheWrite: 1200,
      output: 120,
      thoughts: 40,
      responseOutput: 80,
      estimatedUsed: 35716,
      ctx: 1000000,
      ttftMs: 4250,
      decodeMs: 1500,
      stepIndices: [15, 16],
      executionId: "exec-1",
      slug: "gemini-4-argon",
    }),
  );
  assert.ok(g);
  assert.equal(g.inputTokens, 4516);
  assert.equal(g.cachedTokens, 30000);
  assert.equal(g.cacheWriteTokens, 1200);
  assert.equal(g.outputTokens, 120);
  assert.equal(g.thoughtTokens, 40);
  assert.equal(g.contentTokens, 80);
  assert.equal(g.totalInputTokens, 35716);
  assert.equal(g.contextWindowSize, 1000000);
  assert.equal(g.ttftMs, 4250);
  assert.equal(g.decodeMs, 1500);
  assert.deepEqual(g.stepIndices, [15, 16]);
  assert.equal(g.executionId, "exec-1");
  assert.equal(g.modelSlug, "gemini-4-argon");
});

test("decodeGenMetadata 走 field-17 fallback 且之后字节仍被消费", () => {
  // 上游 #138 的回归位：stats 只在 field 17，且 17 排在 4 之前出现时
  // 字节不消费会把后面的 19/21 全打乱。
  const g = decodeGenMetadata(0, genBlob({ statsAt17: true, input: 777, slug: "claude-opus-5-5-low" }));
  assert.ok(g);
  assert.equal(g.inputTokens, 777);
  assert.equal(g.modelSlug, "claude-opus-5-5-low"); // field 19 must still parse
});

test("decodeGenMetadata 跳过 0-token 失败/中断调用（不覆盖 last，也不计入步数）", () => {
  const g = decodeGenMetadata(
    0,
    genBlob({ input: 0, output: 0, cached: 0, cacheWrite: 0, thoughts: 0, responseOutput: 0 }),
  );
  assert.equal(g, null);
});

test("decodeGenMetadata 对坏 blob 抛错而不是静默", () => {
  assert.throws(() => decodeGenMetadata(0, genBlob({ corrupt: true })));
});

/* ── collect 全链路 ───────────────────────────────────────────────── */

test("agy 快照过真实路径：fresh input、cacheRead、总 output（已含 thoughts）、ctx、轮/步都对", () => {
  const f = newAgySession();
  try {
    // 真实 agy 口径：field 2 (input_tokens) 已经是扣除缓存后的新鲜 input，
    // field 3 (output_tokens) 已经包含 field 9 (thinking_output_tokens)。
    f.addTurn(1, [
      genBlob({ input: 5000, cached: 25000, output: 120, thoughts: 20, ctx: 256000 }),
    ]);
    f.addTurn(1, [
      genBlob({ input: 3000, cached: 32000, output: 60, thoughts: 0, ctx: 256000 }),
    ]);
    const s = collectUsage("a1", {
      provider: "antigravity-cli",
      sessionId: f.sessionId,
      lastUsage: null,
      home: f.home,
    });
    assert.ok(s);
    assert.equal(s.source, "agy-db");
    assert.equal(s.totals?.turns, 2);
    assert.equal(s.totals?.steps, 2);
    assert.equal(s.totals?.input, 8000);
    assert.equal(s.totals?.cacheRead, 57000);
    assert.equal(s.totals?.output, 180); // 120 + 60，不再把 thoughts 重复加一遍
    assert.equal(s.totals?.reasoning, 20);
    // 命中率 = 57000 / (8000 + 57000) = 87.69%，不再因为 input - cached 被截成 0 而虚报 100%
    assert.ok(s.totals?.hitPct !== null && s.totals!.hitPct > 87 && s.totals!.hitPct < 88);
    assert.equal(s.context?.used, 35000); // 3000 + 32000
    assert.equal(s.context?.window, 256000);
  } finally {
    f.cleanup();
  }
});

test("agy 接入真实 TTFT、解码速度、思考时长（thinking_duration − TTFT）与工具区间", () => {
  const f = newAgySession();
  try {
    const t0 = 1_760_000_000_000;
    f.addStep(14, 3); // idx 0: user prompt (turn 1)
    // idx 1: step_type 15 (planner response)
    // TTFT = 2000ms, streaming_duration (decodeMs) = 4000ms,
    // thinking_duration (from created_at) = 3500ms -> thinkMs = 3500 - 2000 = 1500ms, outMs = 2500ms
    const s15 = f.addStep(
      15,
      3,
      stepMetaBlob({
        createdAt: t0,
        viewableAt: t0 + 2000,
        finishedGeneratingAt: t0 + 6000,
        completedAt: t0 + 6010,
        executionId: "exec-turn-1",
      }),
      step15PayloadBlob(3500),
    );
    // idx 2: step_type 132 (tool call running from t0+6100 to t0+7600 = 1500ms)
    const s132 = f.addStep(
      132,
      3,
      stepMetaBlob({
        createdAt: t0 + 5900,
        finishedGeneratingAt: t0 + 6000,
        startedAt: t0 + 6100,
        completedAt: t0 + 7600,
        executionId: "exec-turn-1",
        hasToolCall: true,
      }),
    );
    f.addGen(
      genBlob({
        input: 2000,
        cached: 18000,
        output: 400,
        thoughts: 150,
        responseOutput: 250,
        ttftMs: 2000,
        decodeMs: 4000,
        stepIndices: [s15, s132],
        executionId: "exec-turn-1",
        ctx: 1000000,
      }),
    );

    const s = collectUsage("a-timing", {
      provider: "antigravity",
      sessionId: f.conversationId,
      lastUsage: null,
      home: f.home,
    });
    assert.ok(s);
    assert.equal(s.speed?.ttftMs, 2000);
    assert.equal(s.speed?.decodeMs, 4000);
    assert.equal(s.speed?.thinkMs, 1500);
    assert.equal(s.speed?.outMs, 2500);
    assert.equal(s.speed?.toolMs, 1500);
    assert.equal(s.speed?.tokensPerSecond, 100); // 400 tok / 4s
    assert.equal(s.speed?.latest?.ttftMs, 2000);
    assert.equal(s.speed?.latest?.decodeMs, 4000);
    assert.equal(s.speed?.latest?.tokensPerSecond, 100);
    assert.equal(s.speed?.latest?.thinkMs, 1500);
    assert.equal(s.turnSpeed?.tokensPerSecond, 100);
    assert.equal(s.turnSpeed?.thinkMs, 1500);
    assert.equal(s.turnSpeed?.outMs, 2500);
    assert.equal(s.last?.endedAt, t0 + 6010);
  } finally {
    f.cleanup();
  }
});

test("解码窗口 < 250ms 的缓冲工具调用不虚抬会话/本轮解码速率，但仍计入等待首字与总 token", () => {
  const f = newAgySession();
  try {
    f.addStep(14, 3);
    const s1 = f.addStep(15, 3);
    const s2 = f.addStep(15, 3);
    // 第 1 次调用：正常流式 4s，输出 400 tok -> 100 t/s
    f.addGen(
      genBlob({
        input: 1000,
        cached: 9000,
        output: 400,
        ttftMs: 2000,
        decodeMs: 4000,
        stepIndices: [s1],
        executionId: "exec-1",
      }),
    );
    // 第 2 次调用：整包缓冲的工具调用，TTFT 10s，decodeMs 仅 60ms (< 250ms)，输出 2000 tok
    f.addGen(
      genBlob({
        input: 1000,
        cached: 10000,
        output: 2000,
        ttftMs: 10000,
        decodeMs: 60,
        stepIndices: [s2],
        executionId: "exec-1",
      }),
    );

    const s = collectUsage("a-buffered", {
      provider: "antigravity",
      sessionId: f.conversationId,
      lastUsage: null,
      home: f.home,
    });
    assert.ok(s);
    assert.equal(s.totals?.output, 2400);
    assert.equal(s.speed?.ttftMs, 12000);
    assert.equal(s.speed?.samples, 2);
    // 最近一次调用的 decodeMs < 250ms，单次速率为 null，但首字仍为 10000ms
    assert.equal(s.speed?.latest?.ttftMs, 10000);
    assert.equal(s.speed?.latest?.tokensPerSecond, null);
    // 本轮/会话速率只按流式窗口 >= 250ms 的调用（400 tok / 4s = 100 t/s）计算，不被 2000 tok / 60ms 虚抬
    assert.equal(s.turnSpeed?.tokensPerSecond, 100);
    assert.equal(s.speed?.tokensPerSecond, 100);
  } finally {
    f.cleanup();
  }
});

test("解码失败的行不楔死游标：后面的行照常累计", () => {
  const f = newAgySession();
  try {
    f.addTurn(1, [
      genBlob({ corrupt: true }), // throws → skipped, cursor advances
      genBlob({ input: 9000, output: 10 }),
    ]);
    const s = collectUsage("a1", {
      provider: "antigravity-cli",
      sessionId: f.sessionId,
      lastUsage: null,
      home: f.home,
    });
    assert.ok(s);
    assert.equal(s.totals?.input, 9000);
    assert.equal(s.totals?.steps, 1); // only the good call counted
  } finally {
    f.cleanup();
  }
});

test("没有 conversationId 绑定时落到最新未认领的 db", () => {
  const f = newAgySession();
  try {
    // 抹掉绑定，模拟 adapter 还没写回 conversationId 的首轮窗口。
    writeFileSync(
      join(f.home, ".agy-acp-state", "sessions.json"),
      JSON.stringify({ sessions: { [f.sessionId]: { conversationId: null } } }),
    );
    f.addTurn(1, [genBlob({ input: 1234, output: 5 })]);
    const s = collectUsage("a1", {
      provider: "antigravity-cli",
      sessionId: f.sessionId,
      lastUsage: null,
      home: f.home,
    });
    assert.ok(s);
    assert.equal(s.totals?.input, 1234);
  } finally {
    f.cleanup();
  }
});

test("原生 agy acp（provider: antigravity）直接按 <sessionId>.db 命中，不依赖 sessions.json", () => {
  const f = newAgySession();
  try {
    rmSync(join(f.home, ".agy-acp-state"), { recursive: true, force: true });
    f.addTurn(1, [
      genBlob({
        input: 4096,
        cached: 16384,
        output: 95,
        thoughts: 15,
        ctx: 1000000,
        slug: "gemini-4-carbon-high",
      }),
    ]);
    const s = collectUsage("a-native", {
      provider: "antigravity",
      sessionId: f.conversationId,
      lastUsage: null,
      home: f.home,
    });
    assert.ok(s);
    assert.equal(s.source, "agy-db");
    assert.equal(s.totals?.turns, 1);
    assert.equal(s.totals?.steps, 1);
    assert.equal(s.totals?.input, 4096);
    assert.equal(s.totals?.cacheRead, 16384);
    assert.equal(s.totals?.output, 95);
    assert.equal(s.totals?.reasoning, 15);
    assert.equal(s.context?.used, 20480);
    assert.equal(s.context?.window, 1000000);
  } finally {
    f.cleanup();
  }
});
