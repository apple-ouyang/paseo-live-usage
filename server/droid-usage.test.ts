/**
 * Regression tests for the droid adapter.
 *
 * droid splits its usage across two files: the JSONL carries wall-clock phases
 * (prompt -> assistant = request, assistant tool_use -> tool_result = tool),
 * while `<sid>.settings.json` carries the token counts. The tests build both
 * files exactly like the CLI writes them and go through `collectUsage`.
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { collectUsage } from "./collect.ts";
import { newDroidSession, T0 } from "./droid-fixture.ts";

function snapshot(s: ReturnType<typeof newDroidSession>, provider = "droid-magpie") {
  const usage = collectUsage("test-agent", {
    provider,
    sessionId: s.sessionId,
    lastUsage: null,
    home: s.home,
  });
  assert.ok(usage, "collectUsage produced no droid snapshot");
  return usage;
}

test("单轮：模型/工具窗口各归各位，token 取自 settings.json", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0);
    s.toolCall(T0 + 2_000);
    s.toolResult(T0 + 5_000);
    s.reminder(T0 + 5_100); // bookkeeping, must not re-anchor
    s.assistant(T0 + 8_000);
    s.turnOutcome(T0 + 8_100);
    s.settings({
      lastCallTokenUsage: { inputTokens: 1_000, cacheReadTokens: 9_000, outputTokens: 400 },
      inclusiveTokenUsage: {
        inputTokens: 10_000,
        cacheReadTokens: 90_000,
        outputTokens: 4_000,
        thinkingTokens: 300,
      },
    });
    s.write();

    const usage = snapshot(s);
    assert.equal(usage.source, "droid-session");
    assert.equal(usage.inFlight, false);

    assert.equal(usage.timing?.requestMs, 5_000); // 2s + 3s
    assert.equal(usage.timing?.toolMs, 3_000);
    assert.equal(usage.timing?.totalMs, 8_000);
    assert.equal(usage.timing?.otherMs, 0);

    assert.equal(usage.last?.output, 400);
    assert.equal(usage.last?.input, 1_000);
    assert.equal(usage.last?.cacheRead, 9_000);
    assert.equal(usage.last?.stepMs, 3_000); // tool_result -> final assistant
    assert.equal(usage.last?.tokensPerSecond, 400 / 3);
    assert.equal(usage.last?.hitPct, 90);
    assert.equal(usage.last?.endedAt, T0 + 8_000);

    assert.equal(usage.totals?.input, 10_000);
    assert.equal(usage.totals?.cacheRead, 90_000);
    assert.equal(usage.totals?.output, 4_000);
    assert.equal(usage.totals?.reasoning, 300);
    assert.equal(usage.totals?.hitPct, 90);

    // droid reports factoryCredits, not USD — never invent a cost.
    assert.equal(usage.cost, null);
    assert.equal(usage.speed, undefined);
  } finally {
    s.cleanup();
  }
});

test("注入记录不重锚：hook / reminder / context 块不打断请求窗口", () => {
  const s = newDroidSession();
  try {
    s.hook(T0);
    s.prompt(T0 + 100);
    s.contextBlock(T0 + 200);
    s.reminder(T0 + 300);
    s.todo(T0 + 400);
    s.assistant(T0 + 2_100);
    s.settings({ lastCallTokenUsage: { outputTokens: 55 } });
    s.write();

    const usage = snapshot(s, "droid");
    assert.equal(usage.last?.stepMs, 2_000);
    assert.equal(usage.timing?.requestMs, 2_000);
    assert.equal(usage.timing?.totalMs, 2_000);
    // lastCall has only output: still a real call, but 0/0 hit rate is null.
    assert.equal(usage.last?.hitPct, null);
  } finally {
    s.cleanup();
  }
});

test("factory-droid / factory-droid-rewind 也走 droid adapter", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0);
    s.assistant(T0 + 1_000);
    s.write();
    assert.equal(snapshot(s, "factory-droid").source, "droid-session");
    assert.equal(snapshot(s, "factory-droid-rewind").source, "droid-session");
    assert.equal(snapshot(s, "droid").source, "droid-session");
  } finally {
    s.cleanup();
  }
});

test("task-completion 唤醒是 llm_only 但真开轮；错误告示不重锚", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0);
    s.assistant(T0 + 1_000);
    s.turnOutcome(T0 + 1_100);
    // Hours pass. A task-completion wake-up opens a new turn; without it as the
    // anchor the next assistant gap would fold the whole idle span into
    // requestMs.
    s.taskCompletion(T0 + 100_000);
    s.assistant(T0 + 103_000);
    s.settings({ lastCallTokenUsage: { outputTokens: 90 } });
    s.write();

    const usage = snapshot(s);
    assert.equal(usage.last?.stepMs, 3_000);
    assert.equal(usage.timing?.requestMs, 1_000 + 3_000);
    assert.equal(usage.timing?.totalMs, 4_000);
  } finally {
    s.cleanup();
  }
});

test("错误告示（user_only/both、无 interactionMode）不重锚也不置 inFlight", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0);
    s.toolCall(T0 + 1_000);
    // An error notice lands inside the tool window: it must not steal the
    // tool_result gap nor truncate the tool window.
    s.errorNotice(T0 + 2_000);
    s.toolResult(T0 + 4_000);
    s.assistant(T0 + 6_000);
    s.write();

    const usage = snapshot(s);
    assert.equal(usage.timing?.toolMs, 3_000); // toolCall -> toolResult whole window
    assert.equal(usage.timing?.requestMs, 1_000 + 2_000);
  } finally {
    s.cleanup();
  }
});

test("失败轮末尾的 agent_turn_outcome 清掉 inFlight", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0);
    s.errorNotice(T0 + 500);
    s.turnOutcome(T0 + 600); // model_provider_unavailable: no assistant lands
    s.write();

    const usage = snapshot(s);
    assert.equal(usage.inFlight, false);
  } finally {
    s.cleanup();
  }
});

test("交错 turn：别的 turn 的 outcome 不偷走本 turn 的 tool 窗口", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0); // turn A opens
    const callA = s.toolCall(T0 + 1_000);
    s.taskCompletion(T0 + 2_000); // turn B opens mid-A
    s.turnOutcome(T0 + 2_500); // outcome closes B, A stays open
    const resultA = s.toolResult(T0 + 5_000, "toolu_1", callA);
    s.assistant(T0 + 8_000, undefined, resultA);
    s.write();

    const usage = snapshot(s);
    assert.equal(usage.timing?.toolMs, 3_000); // task-completion anchor -> tool_result
    assert.equal(usage.timing?.requestMs, 1_000 + 3_000);
    assert.equal(usage.timing?.totalMs, 7_000);
    assert.equal(usage.inFlight, false);
  } finally {
    s.cleanup();
  }
});

test("追加读取：先只看到 prompt 时 inFlight，assistant 落盘后结算窗口", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0);
    s.write();
    let usage = snapshot(s);
    assert.equal(usage.inFlight, true);
    assert.equal(usage.timing?.totalMs, 0);

    s.assistant(T0 + 4_000);
    s.append();
    s.settings({ lastCallTokenUsage: { outputTokens: 200 } });
    usage = snapshot(s);
    assert.equal(usage.inFlight, false);
    assert.equal(usage.timing?.requestMs, 4_000);
    assert.equal(usage.last?.stepMs, 4_000);
    assert.equal(usage.last?.tokensPerSecond, 50);
  } finally {
    s.cleanup();
  }
});

test("settings.json 读碎时退回 .bak，两个文件都没有时只剩时间线", () => {
  const s = newDroidSession();
  try {
    s.prompt(T0);
    s.assistant(T0 + 1_000);
    s.write();
    s.settingsBak({
      inclusiveTokenUsage: { inputTokens: 5, cacheReadTokens: 95, outputTokens: 10 },
      lastCallTokenUsage: { inputTokens: 5, cacheReadTokens: 95, outputTokens: 10 },
    });
    // A torn write leaves unparseable JSON in the live file.
    writeFileSync(s.path.replace(/\.jsonl$/, ".settings.json"), '{"tokenUsage":');

    const usage = snapshot(s);
    assert.equal(usage.totals?.output, 10);
    assert.equal(usage.last?.output, 10);

    // No settings at all: timing still comes from the JSONL alone.
    const s2 = newDroidSession("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
    try {
      s2.prompt(T0);
      s2.assistant(T0 + 1_500);
      s2.write();
      const bare = snapshot(s2);
      assert.equal(bare.last, null);
      assert.equal(bare.totals, null);
      assert.equal(bare.timing?.requestMs, 1_500);
    } finally {
      s2.cleanup();
    }
  } finally {
    s.cleanup();
  }
});
