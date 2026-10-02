/**
 * The one place a snapshot becomes an RPC payload.
 *
 * Extracted from `index.server.ts` so the contract test can feed the REAL writer
 * output to the REAL zod parser (`liveUsageGet.output.parseAsync`) instead of a
 * hand-written literal that can silently drift away from the schema.
 */
import type { LiveUsageSupported } from "../shared/rpc.ts";
import type { UsageSnapshot } from "./collect.ts";

export function toUsagePayload(
  snapshot: UsageSnapshot,
  provider: string,
  sessionId: string | null,
): LiveUsageSupported {
  return {
    supported: true,
    provider,
    sessionId,
    source: snapshot.source,
    observedAt: Date.now(),
    sourceAgeMs: snapshot.sourceAgeMs,
    inFlight: snapshot.inFlight,
    last: snapshot.last,
    totals: snapshot.totals,
    context: snapshot.context,
    cost: snapshot.cost,
    timing: snapshot.timing,
    // Deliberately NOT coalesced to null: `undefined` tells the client this
    // provider has no per-token timing, while `null` means "it has it, but no
    // call has landed yet".
    turnSpeed: snapshot.turnSpeed,
    speed: snapshot.speed,
  };
}
