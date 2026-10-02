/**
 * Regression tests for the pi phase aggregate.
 *
 * pi's statusline extension writes one row per model call with `ttftMs`,
 * `decodeMs` and `out` — the same split dsh gets from its chunk timestamps — so
 * the sample reader is what the panel's speed rows depend on.
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { piPhaseAggregate } from "./pi-phase.ts";

/** A throwaway HOME with a pi samples file and one session file per call. */
function newHome() {
  const home = mkdtempSync(join(tmpdir(), "live-usage-pi-"));
  mkdirSync(join(home, ".pi", "agent", "sessions", "cwd"), { recursive: true });
  return {
    home,
    session(name: string, parentSession?: string): string {
      const path = join(home, ".pi", "agent", "sessions", "cwd", `1_${name}.jsonl`);
      const header = { type: "session", id: name, ...(parentSession ? { parentSession } : {}) };
      writeFileSync(path, `${JSON.stringify(header)}\n`);
      return path;
    },
    samples(rows: object[]): void {
      const path = join(home, ".pi", "agent", "statusline-samples.jsonl");
      writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    },
    cleanup(): void {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("按会话汇总 ttft / decode / 输出 token", () => {
  const h = newHome();
  try {
    const path = h.session("aaaa");
    h.samples([
      { session: "aaaa", ttftMs: 1_000, decodeMs: 2_000, thinkMs: 1_500, outMs: 500, out: 400 },
      { session: "aaaa", ttftMs: 500, decodeMs: 4_000, thinkMs: 0, outMs: 4_000, out: 900 },
      // Another session must not leak in.
      { session: "bbbb", ttftMs: 9_999, decodeMs: 9_999, out: 9_999 },
    ]);

    const agg = piPhaseAggregate(h.home, path, "aaaa");
    assert.ok(agg);
    assert.equal(agg.count, 2);
    assert.equal(agg.ttftMs, 1_500);
    assert.equal(agg.decodeMs, 6_000);
    assert.equal(agg.thinkMs, 1_500);
    assert.equal(agg.outMs, 4_500);
    assert.equal(agg.output, 1_300);
  } finally {
    h.cleanup();
  }
});

test("resume 的父链一起汇总", () => {
  const h = newHome();
  try {
    const parent = h.session("parent");
    const child = h.session("child", parent);
    h.samples([
      { session: "parent", ttftMs: 1_000, decodeMs: 1_000, out: 100 },
      { session: "child", ttftMs: 2_000, decodeMs: 3_000, out: 300 },
    ]);

    const agg = piPhaseAggregate(h.home, child, "child");
    assert.ok(agg);
    assert.equal(agg.count, 2);
    assert.equal(agg.ttftMs, 3_000);
    assert.equal(agg.decodeMs, 4_000);
    assert.equal(agg.output, 400);
  } finally {
    h.cleanup();
  }
});

test("没有样本时返回 null，而不是零", () => {
  const h = newHome();
  try {
    const path = h.session("lonely");
    h.samples([{ session: "other", ttftMs: 1, decodeMs: 1, out: 1 }]);
    assert.equal(piPhaseAggregate(h.home, path, "lonely"), null);
  } finally {
    h.cleanup();
  }
});

test("老版本样本没有 thinkMs 字段时不算一次思考采样（未知，不是 0）", () => {
  const h = newHome();
  try {
    const path = h.session("oldver");
    h.samples([
      { session: "oldver", ttftMs: 1_000, decodeMs: 2_000, out: 100 },
      { session: "oldver", ttftMs: 1_000, decodeMs: 2_000, out: 100, thinkMs: 0 },
    ]);
    const agg = piPhaseAggregate(h.home, path, "oldver");
    assert.ok(agg);
    assert.equal(agg.count, 2);
    // Only the row that actually carried the field counts; the collector turns a
    // zero-sample aggregate into `null` so the panel shows 生成, not 思考 0.0s.
    assert.equal(agg.thinkSamples, 1);
    assert.equal(agg.thinkMs, 0);
  } finally {
    h.cleanup();
  }
});

test("样本文件被截断重写时不会重复累加", () => {
  const h = newHome();
  try {
    const path = h.session("trunc");
    h.samples([
      { session: "trunc", ttftMs: 100, decodeMs: 200, out: 10 },
      { session: "trunc", ttftMs: 100, decodeMs: 200, out: 10 },
    ]);
    assert.equal(piPhaseAggregate(h.home, path, "trunc")?.count, 2);

    // Shorter file: the JSONL reader restarts at byte 0, so the fold must reset.
    h.samples([{ session: "trunc", ttftMs: 100, decodeMs: 200, out: 10 }]);
    const after = piPhaseAggregate(h.home, path, "trunc");
    assert.equal(after?.count, 1);
    assert.equal(after?.output, 10);
  } finally {
    h.cleanup();
  }
});
