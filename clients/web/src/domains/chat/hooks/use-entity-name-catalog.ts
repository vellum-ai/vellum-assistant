/**
 * Conversation titles and schedule names currently known to this client,
 * reduced to the unique set that markdown may auto-link.
 *
 * Foreground conversations and the schedule list fetch when the catalog is
 * enabled. Background and scheduled conversations subscribe with `enabled:
 * false` so a name already in cache (sidebar, recents) can still resolve, but
 * chat never kicks off those backlog fetches itself.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  buildEntityNameCatalog,
  EMPTY_ENTITY_NAME_CATALOG,
  type EntityNameCatalog,
} from "@/domains/chat/utils/entity-name-links";
import { useCanQueryDaemon } from "@/hooks/conversation-queries";
import {
  BACKGROUND_FILTER,
  FOREGROUND_FILTER,
  SCHEDULED_FILTER,
} from "@/utils/conversation-list-keys";
import { conversationListOptions } from "@/utils/conversation-list-options";
import { schedulesListQueryOptions } from "@/utils/schedules";

export function useEntityNameCatalog(
  assistantId: string | null,
  enabled: boolean,
): EntityNameCatalog {
  const canQuery = useCanQueryDaemon(assistantId);
  const fetchEnabled = enabled && Boolean(assistantId) && canQuery;

  const foreground = useQuery({
    ...conversationListOptions(assistantId ?? "", FOREGROUND_FILTER),
    enabled: fetchEnabled,
  });
  const background = useQuery({
    ...conversationListOptions(assistantId ?? "", BACKGROUND_FILTER),
    enabled: false,
  });
  const scheduled = useQuery({
    ...conversationListOptions(assistantId ?? "", SCHEDULED_FILTER),
    enabled: false,
  });
  const schedules = useQuery({
    ...schedulesListQueryOptions(assistantId ?? undefined),
    enabled: fetchEnabled,
  });

  return useMemo(() => {
    if (!enabled) {
      return EMPTY_ENTITY_NAME_CATALOG;
    }
    return buildEntityNameCatalog({
      conversations: [
        ...(foreground.data?.conversations ?? []),
        ...(background.data?.conversations ?? []),
        ...(scheduled.data?.conversations ?? []),
      ],
      schedules: schedules.data ?? [],
    });
  }, [
    enabled,
    foreground.data,
    background.data,
    scheduled.data,
    schedules.data,
  ]);
}
