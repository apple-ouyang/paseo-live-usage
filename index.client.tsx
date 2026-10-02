import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { PaseoAgent } from "@getpaseo/client";
import { createPillIcon, UsageDetails } from "./client/pill.tsx";

/**
 * One composer pill per open agent. The pill is dsh-aware: for other providers
 * the daemon answers `supported: false`, and the pill shows "–" instead of
 * pretending there is data.
 */
export default function contribute(client: PluginClientContext) {
  let disposed = false;
  let subscription: { release(): Promise<void> } | null = null;
  const pills = new Map<string, { workspaceId: string; handle: PluginButtonRegistration }>();

  const remove = (agentId: string) => {
    pills.get(agentId)?.handle.remove();
    pills.delete(agentId);
  };

  const upsert = (agent: PaseoAgent) => {
    if (disposed) return;
    const workspaceId = agent.workspaceId;
    if (!workspaceId || agent.status === "closed" || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    if (pills.get(agent.id)?.workspaceId === workspaceId) return;
    remove(agent.id);

    const ref: { handle: PluginButtonRegistration | null } = { handle: null };
    ref.handle = client.addComposerPill({
      id: `live-usage-${agent.id}`,
      workspaceId,
      agentId: agent.id,
      button: {
        title: "实时用量",
        icon: createPillIcon(() => ref.handle, agent.id),
        label: "…",
        behavior: { kind: "popover", Content: UsageDetails },
      },
    });
    pills.set(agent.id, { workspaceId, handle: ref.handle });
  };

  void (async () => {
    try {
      const directory = await client.paseo.agents.list({ subscribe: {}, page: { limit: 200 } });
      if (disposed) {
        await directory.subscription?.release().catch(() => undefined);
        return;
      }
      subscription = directory.subscription ?? null;
      for (const { agent } of directory.entries) upsert(agent);
      directory.subscription?.subscribe({
        snapshot: ({ entries }) => {
          if (!disposed) for (const { agent } of entries) upsert(agent);
        },
        update: (message) => {
          if (disposed || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsert(update.agent);
          else remove(update.agentId);
        },
        error: (error) => console.error("live-usage: catalog subscription failed", error),
      });
    } catch (error) {
      console.error("live-usage: failed to list agents", error);
    }
  })();

  return async () => {
    disposed = true;
    for (const agentId of [...pills.keys()]) remove(agentId);
    await subscription?.release().catch(() => undefined);
  };
}
