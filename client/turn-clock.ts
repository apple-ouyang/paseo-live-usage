/**
 * The live "本轮" clock: one turn's phase wall clock, measured from the agent's
 * timeline stream.
 *
 * Kept as a pure state machine (no React, no Paseo types beyond a structural
 * envelope) so it can be unit-tested: the hook in `use-turn-clock.ts` only wires
 * it to the subscription and a render tick.
 */

/** Mirrors the pi statusline's "本轮" row: live wait / think / output / tool. */
export interface LiveTurnClock {
  running: boolean;
  /**
   * Time from submit to the first streamed chunk. Null when the turn start
   * event was missed (pill mounted mid-turn) and the wait cannot be measured:
   * "unknown" must render as `–`, never as 0.
   */
  waitMs: number | null;
  /** Null when the phase was missed; a seen phase reports its measured time. */
  thinkMs: number | null;
  outMs: number | null;
  toolMs: number;
}

export interface ClockState {
  running: boolean;
  /** `turn_started` was seen, so every phase of this turn is observable. */
  sawTurnStart: boolean;
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

export function createClockState(): ClockState {
  return {
    running: false,
    sawTurnStart: false,
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

export function applyClockEvent(state: ClockState, raw: unknown, now: number): void {
  const event = (raw as StreamEnvelope)?.event;
  if (!event || typeof event.type !== "string") return;

  switch (event.type) {
    case "turn_started":
      closePhase(state, now);
      closeTool(state, now);
      resetTurn(state);
      state.running = true;
      state.sawTurnStart = true;
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

export function readClock(state: ClockState, now: number): LiveTurnClock {
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
  // Mounted mid-turn: a phase that never showed up may have finished before the
  // subscription attached, so its 0 is "unmeasured", not "took no time".
  const phased = (ms: number) => (state.sawTurnStart || ms > 0 ? ms : null);
  return {
    running: state.running,
    waitMs,
    thinkMs: phased(thinkMs),
    outMs: phased(outMs),
    toolMs,
  };
}

export const EMPTY_CLOCK: LiveTurnClock = {
  running: false,
  waitMs: null,
  thinkMs: null,
  outMs: null,
  toolMs: 0,
};
