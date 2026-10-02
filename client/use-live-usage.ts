import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { liveUsageGet, type LiveUsageResult } from "../shared/rpc.ts";

/**
 * Polls the daemon once a second while the pill is mounted. The server resolves
 * the agent's dsh session itself, so the popover and the icon share one query.
 * Reads are incremental (zstd frames appended since the last poll) and guarded
 * by file mtime, so an idle session costs one stat.
 */
export function useLiveUsage(agentId: string) {
  const get = useRpc(liveUsageGet);
  return useQuery<LiveUsageResult>({
    queryKey: ["live-usage", agentId],
    queryFn: () => get({ agentId }),
    enabled: agentId.length > 0,
    staleTime: 500,
    refetchInterval: 1000,
    retry: false,
  });
}
