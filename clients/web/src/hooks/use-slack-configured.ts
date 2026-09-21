import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * Whether the assistant holds Slack credentials, mirroring the `configured`
 * field `use-assistant-channels.ts` derives for the Slack row.
 *
 * Configuration, not liveness, so there is no readiness poll: callers gate an
 * outbound Slack Web API action, which answers perfectly well while the
 * inbound Socket Mode connection is down. Reading channel readiness is a
 * channels concern, which is why it sits here rather than in a feature domain.
 */
export function useSlackConfigured(assistantId: string): boolean {
  const pathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const query = useQuery({
    ...channelsReadinessGetOptions(pathOpts),
    enabled: Boolean(assistantId),
    select: (data) =>
      data.snapshots.some(
        (snapshot) =>
          snapshot.channel === "slack" && snapshot.setupStatus === "ready",
      ),
  });

  return query.data ?? false;
}
