import { usePaseo } from "@getpaseo/plugin/client";
import type { PaseoApi } from "@getpaseo/client";
import { useEffect, useState } from "react";
import {
  applyClockEvent,
  createClockState,
  EMPTY_CLOCK,
  readClock,
  type ClockState,
  type LiveTurnClock,
} from "./turn-clock.ts";

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
    entry = { state: createClockState(), listeners: new Set(), subscription: null, refs: 0 };
    entries.set(agentId, entry);
  }
  entry.refs += 1;
  if (entry.subscription === null && agentId.length > 0) {
    const target = entry;
    const subscription = paseo.agents.ref(agentId).timeline.subscribe((event) => {
      applyClockEvent(target.state, event, Date.now());
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
  return entry ? readClock(entry.state, Date.now()) : EMPTY_CLOCK;
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

export type { LiveTurnClock };
