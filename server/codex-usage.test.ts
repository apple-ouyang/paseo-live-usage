/**
 * Regression tests for the Codex decode accounting.
 *
 * They build a real rollout tree on disk (one JSON object per line, exactly how
 * the Codex CLI writes it) and go through `collectUsage`, so the event dispatch,
 * the per-turn cumulative-token deltas and the window union are exercised
 * together.
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectUsage } from "./collect.ts";
import { newCodexSession, T0 } from "./codex-fixture.ts";

function snapshot(s: ReturnType<typeof newCodexSession>) {
  s.write();
  const usage = collectUsage("test-agent", {
    provider: "codex",
    sessionId: s.sessionId,
    lastUsage: null,
    home: s.home,
  });
  assert.ok(usage, "collectUsage produced no codex snapshot");
  return usage;
}

test("单轮：思考/输出/工具都进各自的窗口，等待首字是残差，四项相加等于轮跨度", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-a";
    s.taskStarted(turn, T0);
    // `UserMessage` has no duration and must not become a phase window.
    s.item(turn, "UserMessage", T0, T0);
    s.item(turn, "Reasoning", T0 + 1_000, T0 + 4_000);
    s.item(turn, "AgentMessage", T0 + 4_000, T0 + 6_000);
    s.item(turn, "CommandExecution", T0 + 6_000, T0 + 7_000);
    s.tokenCount(T0 + 6_000, { output: 100, reasoning: 40 });
    s.taskComplete(turn, T0 + 8_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 8_000) / 1_000,
      durationMs: 8_000,
      ttftMs: 5_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.source, "codex-session");
    assert.equal(usage.inFlight, false);
    assert.equal(usage.totals?.output, 100);
    assert.equal(usage.totals?.reasoning, 40);
    // OpenAI-style accounting: cached input sits inside `input_tokens`.
    assert.equal(usage.totals?.input, 100);
    assert.equal(usage.totals?.cacheRead, 900);
    assert.equal(usage.totals?.hitPct, 90);

    assert.deepEqual(usage.turnSpeed, {
      turn: null,
      output: 100,
      ttftMs: 2_000,
      decodeMs: 5_000,
      samples: 1,
      tokensPerSecond: 20,
      thinkMs: 3_000,
      outMs: 2_000,
      modelMs: 7_000,
    });
    assert.deepEqual(usage.speed, {
      output: 100,
      ttftMs: 2_000,
      decodeMs: 5_000,
      samples: 1,
      tokensPerSecond: 20,
      thinkMs: 3_000,
      outMs: 2_000,
      turns: 1,
      steps: 1,
      modelMs: 7_000,
      toolMs: 1_000,
      ttftAvgMs: 2_000,
    });
    // 等待首字 + 思考 + 输出 + 工具 must equal the turn span Codex reported.
    const speed = usage.speed;
    assert.ok(speed);
    assert.equal(speed.ttftMs + speed.thinkMs! + speed.outMs! + speed.toolMs, 8_000);
    assert.equal(speed.thinkMs! + speed.outMs!, speed.decodeMs);
  } finally {
    s.cleanup();
  }
});

test("有 item 工具窗口时忽略 call/output 配对窗口（不重复计一次执行）", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-b";
    s.taskStarted(turn, T0);
    // A 5s call->output pair that would overstate the tool if it were preferred.
    s.toolPair("call-1", T0 + 500, T0 + 5_500);
    s.item(turn, "CommandExecution", T0 + 1_000, T0 + 2_000);
    s.item(turn, "AgentMessage", T0 + 2_000, T0 + 3_000);
    s.tokenCount(T0 + 3_000, { output: 50 });
    s.taskComplete(turn, T0 + 4_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 4_000) / 1_000,
      durationMs: 4_000,
      ttftMs: 1_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.speed?.toolMs, 1_000);
    assert.equal(usage.speed?.decodeMs, 1_000);
    assert.equal(usage.speed?.ttftMs, 2_000);
  } finally {
    s.cleanup();
  }
});

test("没有 item 工具窗口时，回退到 custom_tool_call / function_call 配对", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-c";
    s.taskStarted(turn, T0);
    s.item(turn, "AgentMessage", T0 + 1_000, T0 + 2_000);
    s.toolPair("call-1", T0 + 2_000, T0 + 5_000, "function_call");
    s.tokenCount(T0 + 5_000, { output: 50 });
    s.taskComplete(turn, T0 + 6_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 6_000) / 1_000,
      durationMs: 6_000,
      ttftMs: 1_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.speed?.toolMs, 3_000);
    assert.equal(usage.speed?.decodeMs, 1_000);
    // 6000 span - 1000 输出 - 3000 工具 = 2000 等待首字
    assert.equal(usage.speed?.ttftMs, 2_000);
    // No reasoning record at all: the split stays unknown, the rate does not.
    assert.equal(usage.speed?.thinkMs, null);
    assert.equal(usage.speed?.outMs, null);
    assert.equal(usage.speed?.tokensPerSecond, 50);
  } finally {
    s.cleanup();
  }
});

test("一个 item 窗口都没有的轮次不给 speed，回退行只有实测的模型/工具", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-d";
    s.taskStarted(turn, T0);
    s.tokenCount(T0 + 1_000, { output: 10 });
    s.taskComplete(turn, T0 + 2_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 2_000) / 1_000,
      durationMs: 2_000,
      ttftMs: 500,
    });

    const usage = snapshot(s);
    // No measured generation window: claiming one would be invented time.
    assert.equal(usage.speed, null);
    assert.equal(usage.turnSpeed, null);
    assert.deepEqual(usage.timing, {
      totalMs: 2_000,
      toolMs: 0,
      requestMs: 2_000,
      otherMs: 0,
    });
    assert.equal(usage.last?.output, 10);
  } finally {
    s.cleanup();
  }
});

test("旧格式只有 completed_at_ms + duration：工具窗口照样能算，思考保持未知", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-e";
    s.taskStarted(turn, T0);
    s.legacyItem(turn, "CommandExecution", T0 + 3_000, 1_500);
    s.tokenCount(T0 + 3_000, { output: 20 });
    s.taskComplete(turn, T0 + 5_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 5_000) / 1_000,
      durationMs: 5_000,
      ttftMs: 1_000,
    });

    const usage = snapshot(s);
    // The turn has no generation window at all, so its 20 output tokens cannot
    // back a rate: it stays out of `speed` and the fallback row shows the
    // measured tool wall clock instead.
    assert.equal(usage.speed, null);
    assert.equal(usage.timing?.toolMs, 1_500);
    assert.equal(usage.timing?.totalMs, 5_000);
    assert.equal(usage.timing?.requestMs, 3_500);
  } finally {
    s.cleanup();
  }
});

test("Reasoning 窗口是 0ms 但确实出了 reasoning token：思考与速率都给 null，不编 0", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-f";
    s.taskStarted(turn, T0);
    // Codex 0.160 writes these items with completed == started for some models.
    s.item(turn, "Reasoning", T0 + 500, T0 + 500);
    s.item(turn, "AgentMessage", T0 + 500, T0 + 3_500);
    s.tokenCount(T0 + 3_500, { output: 200, reasoning: 150 });
    s.taskComplete(turn, T0 + 4_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 4_000) / 1_000,
      durationMs: 4_000,
      ttftMs: 1_000,
    });

    const usage = snapshot(s);
    // The reasoning tokens were generated outside every measured window, so the
    // turn cannot back a rate and stays out of `speed` entirely.
    assert.equal(usage.speed, null);
    assert.equal(usage.turnSpeed?.output, 200);
    assert.equal(usage.turnSpeed?.decodeMs, 3_000);
    assert.equal(usage.turnSpeed?.thinkMs, null);
    assert.equal(usage.turnSpeed?.outMs, null);
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
    // The measured spans are still reported by the fallback row.
    assert.equal(usage.timing?.totalMs, 4_000);
  } finally {
    s.cleanup();
  }
});

test("进行中的轮次也进总量：输出取累计差值，inFlight 为真", () => {
  const s = newCodexSession();
  try {
    s.taskStarted("turn-1", T0);
    s.item("turn-1", "AgentMessage", T0 + 1_000, T0 + 2_000);
    s.tokenCount(T0 + 2_000, { output: 100 });
    s.taskComplete("turn-1", T0 + 3_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 3_000) / 1_000,
      durationMs: 3_000,
    });

    s.taskStarted("turn-2", T0 + 10_000);
    s.item("turn-2", "Reasoning", T0 + 11_000, T0 + 14_000);
    s.item("turn-2", "AgentMessage", T0 + 14_000, T0 + 16_000);
    s.tokenCount(T0 + 16_000, { output: 250, reasoning: 50 });

    const usage = snapshot(s);
    assert.equal(usage.inFlight, true);
    assert.deepEqual(usage.turnSpeed, {
      turn: null,
      output: 150,
      ttftMs: 1_000,
      decodeMs: 5_000,
      samples: 1,
      tokensPerSecond: 30,
      thinkMs: 3_000,
      outMs: 2_000,
      modelMs: 6_000,
    });
    assert.equal(usage.speed?.output, 250);
    assert.equal(usage.speed?.turns, 2);
    assert.equal(usage.speed?.steps, 2);
    assert.equal(usage.speed?.ttftAvgMs, 1_500);
    assert.equal(usage.speed?.tokensPerSecond, 250 / 6);
  } finally {
    s.cleanup();
  }
});

test("归档会话（archived_sessions）也能找到，不是只扫 sessions", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-g";
    s.taskStarted(turn, T0);
    s.item(turn, "AgentMessage", T0 + 1_000, T0 + 2_000);
    s.tokenCount(T0 + 2_000, { output: 80 });
    s.taskComplete(turn, T0 + 3_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 3_000) / 1_000,
      durationMs: 3_000,
    });
    s.write();

    // Codex moves a finished thread's rollout out of `sessions`.
    const archived = join(s.home, ".codex", "archived_sessions");
    mkdirSync(archived, { recursive: true });
    renameSync(s.path, join(archived, `rollout-2026-10-03T00-00-00-${s.sessionId}.jsonl`));

    const usage = collectUsage("test-agent", {
      provider: "codex",
      sessionId: s.sessionId,
      lastUsage: null,
      home: s.home,
    });
    assert.ok(usage);
    assert.equal(usage.source, "codex-session");
    assert.equal(usage.speed?.output, 80);
    assert.equal(usage.speed?.decodeMs, 1_000);
  } finally {
    s.cleanup();
  }
});

test("后续轮次只按自己的累计差值算输出，不重复计上一轮", () => {
  const s = newCodexSession();
  try {
    s.taskStarted("turn-1", T0);
    s.item("turn-1", "Reasoning", T0 + 500, T0 + 1_000);
    s.item("turn-1", "AgentMessage", T0 + 1_000, T0 + 2_000);
    s.tokenCount(T0 + 2_000, { output: 400, reasoning: 100 });
    s.taskComplete("turn-1", T0 + 3_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 3_000) / 1_000,
      durationMs: 3_000,
    });

    s.taskStarted("turn-2", T0 + 10_000);
    s.item("turn-2", "Reasoning", T0 + 11_000, T0 + 12_000);
    s.item("turn-2", "AgentMessage", T0 + 12_000, T0 + 14_000);
    s.tokenCount(T0 + 14_000, { output: 700, reasoning: 200 });
    s.taskComplete("turn-2", T0 + 15_000, {
      startedAtSec: (T0 + 10_000) / 1_000,
      completedAtSec: (T0 + 15_000) / 1_000,
      durationMs: 5_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.speed?.output, 700);
    assert.equal(usage.speed?.turns, 2);
    // turn-2's own window: 1s thinking + 2s output, 300 tokens.
    assert.equal(usage.turnSpeed?.output, 300);
    assert.equal(usage.turnSpeed?.decodeMs, 3_000);
    assert.equal(usage.turnSpeed?.tokensPerSecond, 100);
  } finally {
    s.cleanup();
  }
});

test("一轮多次模型调用：首字均按「调用」平均，不按轮平均", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-h";
    s.taskStarted(turn, T0);
    s.item(turn, "Reasoning", T0 + 1_000, T0 + 2_000);
    s.item(turn, "AgentMessage", T0 + 2_000, T0 + 3_000);
    s.item(turn, "CommandExecution", T0 + 3_000, T0 + 4_000);
    s.item(turn, "Reasoning", T0 + 6_000, T0 + 7_000);
    s.item(turn, "AgentMessage", T0 + 7_000, T0 + 8_000);
    s.item(turn, "CommandExecution", T0 + 8_000, T0 + 9_000);
    s.item(turn, "Reasoning", T0 + 11_000, T0 + 12_000);
    s.item(turn, "AgentMessage", T0 + 12_000, T0 + 13_000);
    s.tokenCount(T0 + 3_000, { output: 100, reasoning: 30 });
    s.tokenCount(T0 + 8_000, { output: 200, reasoning: 70 });
    s.tokenCount(T0 + 13_000, { output: 300, reasoning: 100 });
    s.taskComplete(turn, T0 + 14_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 14_000) / 1_000,
      durationMs: 14_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.speed?.steps, 3);
    // Three generation runs separated by two tool windows.
    assert.equal(usage.speed?.samples, 3);
    assert.equal(usage.speed?.ttftAvgMs, 2_000);
    assert.equal(usage.speed?.thinkMs, 3_000);
    assert.equal(usage.speed?.outMs, 3_000);
    assert.equal(usage.speed?.toolMs, 2_000);
    assert.equal(usage.speed?.ttftMs, 6_000);
    assert.equal(usage.speed?.tokensPerSecond, 50);
    assert.equal(
      usage.speed!.ttftMs + usage.speed!.decodeMs + usage.speed!.toolMs,
      14_000,
      "等待首字 + 生成 + 工具 = 轮跨度",
    );
  } finally {
    s.cleanup();
  }
});

test("轮跨度用 started_at/completed_at，不用事后补写的事件时间戳", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-i";
    // The record was written 30s after the turn actually started, and the turn
    // ran 10s — a forked session replaying its ancestor looks like this.
    s.taskStarted(turn, T0 + 30_000, T0 / 1_000);
    s.item(turn, "Reasoning", T0 + 2_000, T0 + 5_000);
    s.item(turn, "AgentMessage", T0 + 5_000, T0 + 7_000);
    s.item(turn, "CommandExecution", T0 + 7_000, T0 + 8_000);
    s.tokenCount(T0 + 30_000, { output: 120, reasoning: 40 });
    s.taskComplete(turn, T0 + 30_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 10_000) / 1_000,
      durationMs: 10_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.speed?.thinkMs, 3_000);
    assert.equal(usage.speed?.outMs, 2_000);
    assert.equal(usage.speed?.toolMs, 1_000);
    // 10s span - 5s generation - 1s tool = 4s of request latency.
    assert.equal(usage.speed?.ttftMs, 4_000);
    assert.equal(usage.speed!.ttftMs + usage.speed!.decodeMs + usage.speed!.toolMs, 10_000);
  } finally {
    s.cleanup();
  }
});

test("有思考窗口但没有输出窗口：思考/输出与速率都给 null，不编「输出 0.0s」", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-j";
    s.taskStarted(turn, T0);
    s.item(turn, "Reasoning", T0 + 1_000, T0 + 5_000);
    // A tool call whose item window is zero-length (dropped) and no AgentMessage
    // item at all — 16 of 261 Reasoning turns in the newest 60 rollouts look
    // like this.
    s.item(turn, "CommandExecution", T0 + 5_000, T0 + 5_000);
    s.tokenCount(T0 + 5_000, { output: 267, reasoning: 111 });
    s.taskComplete(turn, T0 + 6_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 6_000) / 1_000,
      durationMs: 6_000,
    });

    const usage = snapshot(s);
    // 267 output tokens, but only the 4s reasoning window was measured: the
    // other 156 tokens have no window, so neither the split nor a rate may be
    // derived from it.
    assert.equal(usage.turnSpeed?.output, 267);
    assert.equal(usage.turnSpeed?.decodeMs, 4_000);
    assert.equal(usage.turnSpeed?.thinkMs, null);
    assert.equal(usage.turnSpeed?.outMs, null);
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
    // The only turn cannot join the rate, so the session falls back to the
    // measured 模型 / 工具 row rather than dividing uncovered tokens.
    assert.equal(usage.speed, null);
    assert.deepEqual(usage.timing, {
      totalMs: 6_000,
      toolMs: 0,
      requestMs: 6_000,
      otherMs: 0,
    });
  } finally {
    s.cleanup();
  }
});

test("一轮失败不会清空整场会话的速率：干净轮次照常进 speed，失败轮只让「总」少一截", () => {
  const s = newCodexSession();
  try {
    // Clean turn: thinking + reply windows, all tokens covered.
    s.taskStarted("turn-clean", T0);
    s.item("turn-clean", "Reasoning", T0 + 1_000, T0 + 3_000);
    s.item("turn-clean", "AgentMessage", T0 + 3_000, T0 + 5_000);
    s.tokenCount(T0 + 5_000, { output: 400, reasoning: 100 });
    s.taskComplete("turn-clean", T0 + 6_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 6_000) / 1_000,
      durationMs: 6_000,
    });
    // Failed turn (overloaded): reasoning window only, reply tokens uncovered.
    s.taskStarted("turn-failed", T0 + 100_000);
    s.item("turn-failed", "Reasoning", T0 + 101_000, T0 + 103_000);
    s.tokenCount(T0 + 103_000, { output: 900, reasoning: 100 });
    s.taskComplete("turn-failed", T0 + 104_000, {
      startedAtSec: (T0 + 100_000) / 1_000,
      completedAtSec: (T0 + 104_000) / 1_000,
      durationMs: 4_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.speed?.turns, 1);
    assert.equal(usage.speed?.output, 400);
    assert.equal(usage.speed?.decodeMs, 4_000);
    assert.equal(usage.speed?.tokensPerSecond, 100);
    assert.equal(usage.speed?.thinkMs, 2_000);
    assert.equal(usage.speed?.outMs, 2_000);
    // The failed turn's 4s span stays out of `总`; the fallback row still holds it.
    assert.equal(usage.speed!.modelMs + usage.speed!.toolMs, 6_000);
    assert.equal(usage.timing?.totalMs, 10_000);
    // 本轮 is the failed turn, and it honestly reports no rate.
    assert.equal(usage.turnSpeed?.tokensPerSecond, null);
  } finally {
    s.cleanup();
  }
});

test("全部输出 token 都是思考 token 时，输出 0.0s 是真 0，速率照给", () => {
  const s = newCodexSession();
  try {
    const turn = "turn-k";
    s.taskStarted(turn, T0);
    s.item(turn, "Reasoning", T0 + 1_000, T0 + 5_000);
    s.item(turn, "CommandExecution", T0 + 5_000, T0 + 6_000);
    // No non-reasoning output: every output token is covered by the window.
    s.tokenCount(T0 + 6_000, { output: 200, reasoning: 200 });
    s.taskComplete(turn, T0 + 7_000, {
      startedAtSec: T0 / 1_000,
      completedAtSec: (T0 + 7_000) / 1_000,
      durationMs: 7_000,
    });

    const usage = snapshot(s);
    assert.equal(usage.turnSpeed?.thinkMs, 4_000);
    assert.equal(usage.turnSpeed?.outMs, 0);
    assert.equal(usage.turnSpeed?.tokensPerSecond, 50);
  } finally {
    s.cleanup();
  }
});
