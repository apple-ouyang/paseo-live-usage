/**
 * Regression tests for the live 本轮 clock.
 *
 * The daemon only pushes live events, so a pill mounted mid-turn can never know
 * when the turn started or whether a phase already finished. Those phases must
 * read as unknown, not as a measured 0 — that is the whole point of tracking
 * `sawTurnStart` separately from the phase totals.
 *
 *   node --test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyClockEvent, createClockState, readClock } from "./turn-clock.ts";

const T0 = 1_790_000_000_000;

function turnStarted() {
  return { event: { type: "turn_started" } };
}
function reasoning(text = "a") {
  return { event: { type: "timeline", item: { type: "reasoning", text } } };
}
function assistant(text = "hi") {
  return { event: { type: "timeline", item: { type: "assistant_message", text } } };
}
function tool(callId: string, status: "running" | "completed") {
  return { event: { type: "timeline", item: { type: "tool_call", callId, status } } };
}
function turnEnded(type = "turn_completed") {
  return { event: { type } };
}

test("从 turn_started 起全程可见：等待/思考/输出/工具都是实测值，0 思考就是 0", () => {
  const state = createClockState();
  applyClockEvent(state, turnStarted(), T0);
  applyClockEvent(state, reasoning(), T0 + 1_000);
  applyClockEvent(state, assistant(), T0 + 3_000);
  applyClockEvent(state, tool("c1", "running"), T0 + 4_000);
  applyClockEvent(state, tool("c1", "completed"), T0 + 6_000);
  applyClockEvent(state, assistant(), T0 + 8_000);
  applyClockEvent(state, turnEnded(), T0 + 9_000);

  const clock = readClock(state, T0 + 9_000);
  assert.equal(clock.running, false);
  assert.equal(clock.waitMs, 1_000);
  assert.equal(clock.thinkMs, 2_000);
  // Two output stretches: the text before the tool call, and the one after it.
  assert.equal(clock.outMs, 2_000);
  assert.equal(clock.toolMs, 2_000);
});

test("turn_started 全程可见但这一轮没有思考：思考是 0，不是未知", () => {
  const state = createClockState();
  applyClockEvent(state, turnStarted(), T0);
  applyClockEvent(state, assistant(), T0 + 500);
  applyClockEvent(state, turnEnded(), T0 + 2_000);

  const clock = readClock(state, T0 + 2_000);
  assert.equal(clock.waitMs, 500);
  assert.equal(clock.thinkMs, 0);
  assert.equal(clock.outMs, 1_500);
});

test("中途挂载（错过 turn_started）：等待和没见过的相位给 null，不编 0", () => {
  const state = createClockState();
  // Mounted while the model was already thinking.
  applyClockEvent(state, reasoning(), T0 + 10_000);
  applyClockEvent(state, assistant(), T0 + 12_000);
  applyClockEvent(state, turnEnded(), T0 + 13_000);

  const clock = readClock(state, T0 + 13_000);
  assert.equal(clock.waitMs, null);
  // Thinking was seen (partially, from the mount), so it reports a number.
  assert.equal(clock.thinkMs, 2_000);
  assert.equal(clock.outMs, 1_000);
});

test("中途挂载且这个相位一次都没出现：给 null，不是 0.0s", () => {
  const state = createClockState();
  // Mounted during a tool call: the whole answer had already streamed.
  applyClockEvent(state, tool("c1", "running"), T0 + 10_000);
  applyClockEvent(state, tool("c1", "completed"), T0 + 11_000);
  applyClockEvent(state, turnEnded(), T0 + 12_000);

  const clock = readClock(state, T0 + 12_000);
  assert.equal(clock.waitMs, null);
  assert.equal(clock.thinkMs, null);
  assert.equal(clock.outMs, null);
  assert.equal(clock.toolMs, 1_000);
});

test("并行工具只算一段墙钟，不是各自相加", () => {
  const state = createClockState();
  applyClockEvent(state, turnStarted(), T0);
  applyClockEvent(state, assistant(), T0 + 100);
  applyClockEvent(state, tool("a", "running"), T0 + 1_000);
  applyClockEvent(state, tool("b", "running"), T0 + 1_000);
  // Both still running at +3s: the open batch counts once, from the first start.
  const before = readClock(state, T0 + 3_000);
  assert.equal(before.toolMs, 2_000);
  assert.equal(before.thinkMs, 0);

  applyClockEvent(state, tool("a", "completed"), T0 + 5_000);
  applyClockEvent(state, tool("b", "completed"), T0 + 5_000);
  assert.equal(readClock(state, T0 + 5_000).toolMs, 4_000);
});

test("新一轮 turn_started 会重置上一轮的相位", () => {
  const state = createClockState();
  applyClockEvent(state, turnStarted(), T0);
  applyClockEvent(state, reasoning(), T0 + 100);
  applyClockEvent(state, assistant(), T0 + 1_000);
  applyClockEvent(state, turnEnded(), T0 + 2_000);
  assert.equal(readClock(state, T0 + 2_000).thinkMs, 900);

  applyClockEvent(state, turnStarted(), T0 + 100_000);
  const clock = readClock(state, T0 + 100_000);
  assert.equal(clock.running, true);
  assert.equal(clock.thinkMs, 0);
  assert.equal(clock.waitMs, 0);
  assert.equal(clock.toolMs, 0);
});
