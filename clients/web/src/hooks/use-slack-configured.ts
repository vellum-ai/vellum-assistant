import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { isChannelConfigured } from "@/types/channel-types";

/**
 * Whether the assistant holds Slack credentials, over the same predicate
 * `use-assistant-channels.ts` derives the Slack row's `configured` from.
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
          snapshot.channel === "slack" && isChannelConfigured(snapshot),
      ),
  });

  return query.data ?? false;
}
