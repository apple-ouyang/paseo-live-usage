/**
 * The cross-process contract test.
 *
 * Every other test compares a hand-written literal against the reader, which can
 * never catch the schema drifting away from the writer. This one runs the real
 * path end to end:
 *
 *   real session store -> collectUsage -> toUsagePayload -> liveUsageGet.output.parseAsync
 *
 * so a field that stops satisfying the zod output schema (a missing `.nullable()`,
 * a NaN, a wrong `int`) fails here instead of silently blanking the panel.
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liveUsageGet, type LiveUsageSupported } from "../shared/rpc.ts";
import { collectUsage } from "./collect.ts";
import { toUsagePayload } from "./payload.ts";
import { newSession, step, T0 } from "./dsh-fixture.ts";

/** Real snapshot -> real payload -> real zod parse. */
async function roundTrip(
  home: string,
  provider: string,
  sessionId: string,
): Promise<LiveUsageSupported> {
  const snapshot = collectUsage("test-agent", {
    provider,
    sessionId,
    lastUsage: null,
    home,
  });
  assert.ok(snapshot, `collectUsage produced no snapshot for ${provider}`);
  const parsed = await liveUsageGet.output.parseAsync(toUsagePayload(snapshot, provider, sessionId));
  assert.equal(parsed.supported, true);
  return parsed as LiveUsageSupported;
}

test("真实 dsh 快照过真实 zod schema，且耗时拆分闭合", async () => {
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
          firstChunkAt: T0 + 1_000,
          endAt: T0 + 3_000,
          thinkMs: 500,
        }),
        s.event("turn/end", T0 + 3_000, { turn: 1 }),
      ]),
    );

    const parsed = await roundTrip(s.home, "dsh", s.sessionId);
    assert.equal(parsed.source, "dsh-log");
    assert.equal(parsed.speed?.output, 100);
    assert.equal(parsed.speed?.ttftMs, 1_000);
    assert.equal(parsed.speed?.decodeMs, 2_000);
    assert.equal(parsed.speed?.samples, 1);
    assert.equal(parsed.speed?.tokensPerSecond, 50);
    assert.equal(parsed.speed?.thinkMs, 500);
    assert.equal(parsed.speed?.outMs, 1_500);
    assert.equal(
      (parsed.speed?.thinkMs ?? 0) + (parsed.speed?.outMs ?? 0),
      parsed.speed?.decodeMs,
      "思考 + 输出 must equal 生成",
    );
    assert.equal(parsed.turnSpeed?.turn, 1);
    assert.equal(parsed.turnSpeed?.tokensPerSecond, 50);
  } finally {
    s.cleanup();
  }
});

test("没有思考记录时 thinkMs/outMs 过 schema 后仍是 null，不是 0 也不是被 strip", async () => {
  const s = newSession();
  try {
    writeFileSync(
      s.path,
      s.frame([
        s.event("turn/start", T0, { turn: 1 }),
        ...step(s, {
          turn: 1,
          step: 1,
          output: 40,
          startAt: T0,
          firstChunkAt: T0,
          endAt: T0 + 1_000,
          thinking: false,
        }),
        s.event("turn/end", T0 + 1_000, { turn: 1 }),
      ]),
    );

    const parsed = await roundTrip(s.home, "dsh", s.sessionId);
    assert.ok(parsed.speed);
    assert.equal(parsed.speed.decodeMs, 1_000);
    assert.equal(parsed.speed.thinkMs, null);
    assert.equal(parsed.speed.outMs, null);
    // The key must survive as null, so the client can tell "unknown" from "0".
    assert.ok("thinkMs" in parsed.speed);
    assert.ok("outMs" in parsed.speed);
  } finally {
    s.cleanup();
  }
});

test("没有逐 token 计时的 provider：speed/turnSpeed 过 schema 后是 undefined", async () => {
  const home = mkdtempSync(join(tmpdir(), "live-usage-claude-"));
  const sessionId = "22222222-3333-4444-5555-666666666666";
  try {
    const dir = join(home, ".claude", "projects", "--test--");
    mkdirSync(dir, { recursive: true });
    const lines = [
      {
        type: "user",
        timestamp: "2026-10-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-10-01T00:00:05.000Z",
        message: {
          id: "msg-1",
          role: "assistant",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
          content: [{ type: "text", text: "ok" }],
        },
      },
      // Claude Code appends session-cumulative cost rows carrying the real USD
      // cost; that is the only cost source this plugin will report.
      {
        type: "cost-state",
        sessionId,
        totalCostUSD: 0.22049159999999998,
        totalAPIDuration: 27_726,
        totalToolDuration: 0,
        modelUsage: { "claude-opus-5-5": { outputTokens: 1_171, thinkingTokens: 367 } },
      },
    ];
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );

    const parsed = await roundTrip(home, "claude", sessionId);
    assert.equal(parsed.source, "claude-session");
    assert.equal(parsed.totals?.output, 5);
    // `undefined` is what tells the client "this store has no per-token timing",
    // so it must not be coalesced to null anywhere along the way.
    assert.equal(parsed.speed, undefined);
    assert.equal(parsed.turnSpeed, undefined);
    assert.deepEqual(parsed.cost, { value: 0.22049159999999998, currency: "USD" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("没有成本字段的会话不给花费，也不拿价目表算一个", async () => {
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

    const parsed = await roundTrip(s.home, "dsh", s.sessionId);
    assert.equal(parsed.source, "dsh-log");
    assert.ok(parsed.totals);
    // dsh's log has no cost field. The panel shows nothing rather than a number
    // derived from a price table, so this must stay null.
    assert.equal(parsed.cost, null);
  } finally {
    s.cleanup();
  }
});

test("pi 老版本样本没有 thinkMs：面板拿到的是 null，不是 0 秒思考", async () => {
  const home = mkdtempSync(join(tmpdir(), "live-usage-pi-"));
  const sessionId = "33333333-4444-5555-6666-777777777777";
  try {
    // A real pi session file plus a statusline sample written by an older
    // extension version, which had no `thinkMs` field at all.
    const sessions = join(home, ".pi", "agent", "sessions", "--test--");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `1_${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    );
    writeFileSync(
      join(home, ".pi", "agent", "statusline-samples.jsonl"),
      `${JSON.stringify({ session: sessionId, ttftMs: 1_000, decodeMs: 2_000, out: 100 })}\n`,
    );

    const parsed = await roundTrip(home, "pi", sessionId);
    assert.equal(parsed.source, "pi-session");
    assert.equal(parsed.speed?.output, 100);
    assert.equal(parsed.speed?.decodeMs, 2_000);
    // Unknown thinking must survive the schema as null (the panel then shows the
    // whole 生成 window), never as a fabricated 0.
    assert.equal(parsed.speed?.thinkMs, null);
    assert.equal(parsed.speed?.outMs, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
