import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { liveUsageGet } from "./shared/rpc.ts";
import { collectUsage, type LastUsageLike } from "./server/collect.ts";
import { toUsagePayload } from "./server/payload.ts";

interface ResolvedTarget {
  provider: string | null;
  sessionId: string | null;
  lastUsage: LastUsageLike | null;
  running: boolean;
}

/** Refresh the agent snapshot at most this often; file adapters do not need it. */
const REFRESH_INTERVAL_MS = 2_000;
const refreshedAt = new Map<string, number>();

async function resolveTarget(
  paseo: PaseoApi,
  agentId: string,
  known: { provider?: string | null; sessionId?: string | null },
): Promise<ResolvedTarget> {
  const handle = paseo.agents.ref(agentId);
  const needsRefresh =
    handle.runtimeInfo === null || Date.now() - (refreshedAt.get(agentId) ?? 0) > REFRESH_INTERVAL_MS;
  if (needsRefresh) {
    try {
      await handle.refresh();
      refreshedAt.set(agentId, Date.now());
    } catch {
      // keep the last observed snapshot
    }
  }
  const agent = handle.current();
  return {
    provider: agent?.provider ?? handle.runtimeInfo?.provider ?? known.provider ?? null,
    sessionId: handle.runtimeInfo?.sessionId ?? known.sessionId ?? null,
    lastUsage: (handle.lastUsage ?? agent?.lastUsage ?? null) as LastUsageLike | null,
    running: agent?.status === "running" || agent?.activeTurn != null,
  };
}

export default function contribute(server: PluginServerContext) {
  server.handle(liveUsageGet, async (input, context) => {
    try {
      const target = await resolveTarget(context.paseo, input.agentId, {
        provider: input.provider ?? null,
        sessionId: input.sessionId ?? null,
      });

      const snapshot = collectUsage(input.agentId, {
        provider: target.provider,
        sessionId: target.sessionId,
        lastUsage: target.lastUsage,
        running: target.running,
      });
      if (!snapshot) {
        return {
          supported: false as const,
          reason: `no usage source for provider ${target.provider ?? "unknown"}`,
        };
      }

      return toUsagePayload(snapshot, target.provider ?? "unknown", target.sessionId);
    } catch (error) {
      return {
        supported: false as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return () => {
    refreshedAt.clear();
  };
}
