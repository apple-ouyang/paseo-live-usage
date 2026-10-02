import { usePaseo } from "@getpaseo/plugin/client";
import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { useEffect, useState } from "react";

/** Mirrors the pi statusline's "本轮" row: live wait / think / output / tool. */
export interface LiveTurnClock {
  running: boolean;
  /**
   * Time from submit to the first streamed chunk. Null when the turn start
   * event was missed (pill mounted mid-turn) and the wait cannot be measured:
   * "unknown" must render as `–`, never as 0.
   */
  waitMs: number | null;
  thinkMs: number;
  outMs: number;
  toolMs: number;
}

interface ClockState {
  running: boolean;
  ttftAnchor: number | null;
  firstDeltaAt: number | null;
  phase: "wait" | "think" | "out" | null;
  phaseStartedAt: number | null;
  thinkMs: number;
  outMs: number;
  /** Null = turn start missed, wait unmeasured. */
  waitMs: number | null;
  toolActive: Set<string>;
  toolStartedAt: number | null;
  toolMs: number;
}

function createState(): ClockState {
  return {
    running: false,
    ttftAnchor: null,
    firstDeltaAt: null,
    phase: null,
    phaseStartedAt: null,
    thinkMs: 0,
    outMs: 0,
    waitMs: null,
    toolActive: new Set(),
    toolStartedAt: null,
    toolMs: 0,
  };
}

function closePhase(state: ClockState, now: number): void {
  if (state.phaseStartedAt === null) return;
  const elapsed = Math.max(0, now - state.phaseStartedAt);
  if (state.phase === "think") state.thinkMs += elapsed;
  else if (state.phase === "out") state.outMs += elapsed;
  state.phase = null;
  state.phaseStartedAt = null;
}

function switchPhase(state: ClockState, phase: "think" | "out", now: number): void {
  if (state.phase === phase) return;
  closePhase(state, now);
  state.phase = phase;
  state.phaseStartedAt = now;
}

/**
 * Accumulate the elapsed tool wall clock. Takes the "is anything still running" answer
 * from the caller because the caller has already updated the active set by the time a
 * tool finishes — checking `toolActive` here made every measurement zero.
 */
function addToolElapsed(state: ClockState, now: number): void {
  if (state.toolStartedAt === null) return;
  state.toolMs += Math.max(0, now - state.toolStartedAt);
  state.toolStartedAt = null;
}

/** Close the current tool batch; only called once the last tool has finished. */
function closeTool(state: ClockState, now: number): void {
  if (state.toolActive.size > 0) return;
  addToolElapsed(state, now);
}

function onFirstDelta(state: ClockState, now: number): void {
  if (state.firstDeltaAt !== null) return;
  state.firstDeltaAt = now;
  // No anchor (subscription attached mid-turn): the wait is unknown, not 0.
  state.waitMs = state.ttftAnchor !== null ? Math.max(0, now - state.ttftAnchor) : null;
}

function resetTurn(state: ClockState): void {
  state.phase = null;
  state.phaseStartedAt = null;
  state.thinkMs = 0;
  state.outMs = 0;
  state.waitMs = null;
  state.toolActive.clear();
  state.toolStartedAt = null;
  state.toolMs = 0;
  state.firstDeltaAt = null;
}

/** Structural view of the daemon's stream envelope; avoids a protocol type import. */
interface StreamEnvelope {
  event?: {
    type?: string;
    item?: { type?: string; text?: string; callId?: string; status?: string };
  };
}

function applyEvent(state: ClockState, raw: PaseoAgentTimelineEvent, now: number): void {
  const event = (raw as StreamEnvelope)?.event;
  if (!event || typeof event.type !== "string") return;

  switch (event.type) {
    case "turn_started":
      closePhase(state, now);
      closeTool(state, now);
      resetTurn(state);
      state.running = true;
      state.ttftAnchor = now;
      state.phase = "wait";
      state.phaseStartedAt = now;
      return;
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled": {
      closePhase(state, now);
      closeTool(state, now);
      if (state.firstDeltaAt === null && state.ttftAnchor !== null) {
        state.waitMs = Math.max(0, now - state.ttftAnchor);
      }
      state.running = false;
      state.ttftAnchor = null;
      return;
    }
    case "timeline": {
      const item = event.item;
      if (!item) return;
      // A streaming item is proof a turn is running even when `turn_started`
      // predates the subscription (the pill mounted mid-turn).
      if (
        !state.running &&
        (item.type === "assistant_message" || item.type === "reasoning" || item.type === "tool_call")
      ) {
        state.running = true;
      }
      if (item.type === "assistant_message") {
        onFirstDelta(state, now);
        switchPhase(state, "out", now);
        return;
      }
      if (item.type === "reasoning") {
        onFirstDelta(state, now);
        switchPhase(state, "think", now);
        return;
      }
      if (item.type === "tool_call") {
        closePhase(state, now);
        const callId = item.callId ?? "";
        if (item.status === "running") {
          if (state.toolActive.size === 0) state.toolStartedAt = now;
          state.toolActive.add(callId);
        } else if (state.toolActive.delete(callId) && state.toolActive.size === 0) {
          closeTool(state, now);
        }
        return;
      }
      return;
    }
    default:
      return;
  }
}

function snapshot(state: ClockState, now: number): LiveTurnClock {
  const waiting = state.running && state.firstDeltaAt === null && state.ttftAnchor !== null;
  const waitMs =
    waiting && state.ttftAnchor !== null ? Math.max(0, now - state.ttftAnchor) : state.waitMs;
  const thinkMs =
    state.thinkMs +
    (state.phase === "think" && state.phaseStartedAt !== null ? now - state.phaseStartedAt : 0);
  const outMs =
    state.outMs +
    (state.phase === "out" && state.phaseStartedAt !== null ? now - state.phaseStartedAt : 0);
  const toolMs =
    state.toolMs +
    (state.toolActive.size > 0 && state.toolStartedAt !== null ? now - state.toolStartedAt : 0);
  return {
    running: state.running,
    waitMs,
    thinkMs,
    outMs,
    toolMs,
  };
}

/**
 * One timeline subscription per agent, shared by pill and popover. The pill
 * acquires it, so the last completed turn is still there when the popover opens
 * after the turn ended (the daemon only delivers live events, not history).
 */
interface ClockEntry {
  state: ClockState;
  listeners: Set<() => void>;
  subscription: { ready?: Promise<unknown>; release(): Promise<void> } | null;
  refs: number;
}

const entries = new Map<string, ClockEntry>();

function acquire(paseo: PaseoApi, agentId: string): () => void {
  let entry = entries.get(agentId);
  if (!entry) {
    entry = { state: createState(), listeners: new Set(), subscription: null, refs: 0 };
    entries.set(agentId, entry);
  }
  entry.refs += 1;
  if (entry.subscription === null && agentId.length > 0) {
    const target = entry;
    const subscription = paseo.agents.ref(agentId).timeline.subscribe((event) => {
      applyEvent(target.state, event, Date.now());
      for (const listener of target.listeners) listener();
    });
    subscription.ready?.catch(() => undefined);
    entry.subscription = subscription;
  }
  return () => {
    const current = entries.get(agentId);
    if (!current) return;
    current.refs -= 1;
    if (current.refs <= 0) {
      void current.subscription?.release().catch(() => undefined);
      entries.delete(agentId);
    }
  };
}

function read(agentId: string): LiveTurnClock {
  const entry = entries.get(agentId);
  return entry
    ? snapshot(entry.state, Date.now())
    : {
        running: false,
        waitMs: null,
        thinkMs: 0,
        outMs: 0,
        toolMs: 0,
      };
}

export function useTurnClock(agentId: string): LiveTurnClock {
  const paseo = usePaseo();
  const [clock, setClock] = useState<LiveTurnClock>(() => read(agentId));

  useEffect(() => {
    if (agentId.length === 0) return;
    const release = acquire(paseo, agentId);
    const entry = entries.get(agentId);
    const update = () => setClock(read(agentId));
    update();
    entry?.listeners.add(update);
    const timer = setInterval(() => {
      if (entries.get(agentId)?.state.running) update();
    }, 250);
    return () => {
      clearInterval(timer);
      entry?.listeners.delete(update);
      release();
    };
  }, [paseo, agentId]);

  return clock;
}
