import { usePaseo } from "@getpaseo/plugin/client";
import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { useEffect, useState } from "react";

/** Sum of the completed turns this client observed, for thread-level ratios. */
export interface TurnHistory {
  turns: number;
  /** Σ measured; turns whose start event was missed contribute only think/out. */
  waitMs: number;
  thinkMs: number;
  outMs: number;
}

/** Mirrors the pi statusline's "本轮" row: live wait / think / output / tool. */
export interface LiveTurnClock {
  running: boolean;
  /**
   * Time from submit to the first streamed chunk. Null when the turn start
   * event was missed (pill mounted mid-turn) and the wait cannot be measured —
   * "unknown" is not 0, and the thread-level split must not read it as 0.
   */
  waitMs: number | null;
  thinkMs: number;
  outMs: number;
  toolMs: number;
  /**
   * dsh's own live decode rate, same definition as the badge in `dsh-tui`:
   * estimated tokens ÷ generation wall clock (think + out phases only). Tool
   * execution and the wait for the first token sit in neither side, so a slow
   * tool or a long TTFT cannot drag it down. Null until the generation window
   * reaches MIN_SAMPLE_MS.
   */
  liveTps: number | null;
  /** Estimated VISIBLE output tokens (reasoning excluded) in the current turn. */
  liveTokens: number;
  history: TurnHistory;
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
  /** Set once the finished turn was folded into `history`. */
  foldedTurn: boolean;
  history: TurnHistory;
  toolActive: Set<string>;
  toolStartedAt: number | null;
  toolMs: number;
  /** All streamed characters (thinking + visible), for the decode-rate estimate. */
  streamedChars: number;
  /** Visible output characters only, for the "流出" row. */
  outChars: number;
  lastText: { reasoning: string; assistant_message: string };
}

/**
 * dsh-tui's own live estimator is a flat four characters per token
 * (`pi-nano-context` in channel/usage.js). Matching it keeps this preview on
 * the same scale as the settled file value instead of inventing a second one.
 */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * A live rate needs a real sample. dsh's own badge starts at the first
 * character, so a 0.25s window holding one character reads as "4 t/s"; the
 * panel must not flash that at the start of every turn.
 */
const MIN_LIVE_MS = 1_000;
const MIN_LIVE_TOKENS = 8;

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
    foldedTurn: false,
    history: { turns: 0, waitMs: 0, thinkMs: 0, outMs: 0 },
    toolActive: new Set(),
    toolStartedAt: null,
    toolMs: 0,
    streamedChars: 0,
    outChars: 0,
    lastText: { reasoning: "", assistant_message: "" },
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
  state.foldedTurn = false;
  state.toolActive.clear();
  state.toolStartedAt = null;
  state.toolMs = 0;
  state.firstDeltaAt = null;
  state.streamedChars = 0;
  state.outChars = 0;
  state.lastText = { reasoning: "", assistant_message: "" };
}

/** Fold one finished turn into the per-agent history (survives resetTurn). */
function foldTurn(state: ClockState): void {
  if (state.foldedTurn) return;
  state.foldedTurn = true;
  if (state.waitMs === null && state.thinkMs === 0 && state.outMs === 0) return;
  state.history.turns += 1;
  state.history.waitMs += state.waitMs ?? 0;
  state.history.thinkMs += state.thinkMs;
  state.history.outMs += state.outMs;
}

function addStreamedText(
  state: ClockState,
  type: "reasoning" | "assistant_message",
  text: string,
): void {
  if (!text) return;
  const previous = state.lastText[type];
  const delta = text === previous ? "" : text.startsWith(previous) ? text.slice(previous.length) : text;
  state.lastText[type] = text;
  if (!delta) return;
  // Both phases stream tokens, so the decode-rate estimate counts both; the
  // "流出" row is about what the user receives and must not count thinking text.
  const chars = delta.length;
  state.streamedChars += chars;
  if (type === "assistant_message") state.outChars += chars;
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
      foldTurn(state);
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
        addStreamedText(state, "assistant_message", item.text ?? "");
        switchPhase(state, "out", now);
        return;
      }
      if (item.type === "reasoning") {
        onFirstDelta(state, now);
        addStreamedText(state, "reasoning", item.text ?? "");
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
  const generationMs = thinkMs + outMs;
  const estimatedTokens = estimateTokens(state.streamedChars);
  const liveTps =
    generationMs >= MIN_LIVE_MS && estimatedTokens >= MIN_LIVE_TOKENS
      ? estimatedTokens / (generationMs / 1000)
      : null;
  return {
    running: state.running,
    waitMs,
    thinkMs,
    outMs,
    toolMs,
    liveTps,
    liveTokens: estimateTokens(state.outChars),
    history: { ...state.history },
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
        liveTps: null,
        liveTokens: 0,
        history: { turns: 0, waitMs: 0, thinkMs: 0, outMs: 0 },
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
