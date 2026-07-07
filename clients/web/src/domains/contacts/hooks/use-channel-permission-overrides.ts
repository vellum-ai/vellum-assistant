import { useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  CHANNEL_TIER_CONTACT_TYPES,
  defaultTierFromCells,
  tierOverridesFromCells,
  type SlackCapabilityTier,
} from "@/domains/contacts/slack-channel-overrides";
import {
  assistantChannelPermissionOverridesListOptions,
  assistantChannelPermissionOverridesListQueryKey,
} from "@/generated/gateway/@tanstack/react-query.gen";
import {
  assistantChannelPermissionOverrideDelete,
  assistantChannelPermissionOverrideSet,
} from "@/generated/gateway/sdk.gen";
import type { AssistantChannelPermissionOverridesListResponse } from "@/generated/gateway/types.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { toastOnError } from "@/utils/mutation-error";

type CellList = AssistantChannelPermissionOverridesListResponse;
type Cell = CellList["cells"][number];
type WireCell = Omit<Cell, "updatedAt">;

export interface ChannelPermissionOverridesController {
  /** Persisted tier per channel external id, or `undefined` while the feature is off. */
  tierOverrides?: Record<string, SlackCapabilityTier>;
  /**
   * Winning broader-scope cell per room kind (the default a cell-less
   * channel of that type resolves to before the global thresholds).
   * `null` per kind when no broader cell exists.
   */
  typeDefaults?: Record<"public" | "private", SlackCapabilityTier | null>;
  /** Channels with a cell write/delete in flight. */
  pendingChannelIds: ReadonlySet<string>;
  /** True until the cells have loaded at least once. */
  isLoading: boolean;
  isError: boolean;
  /** Persist a tier as channel-ID cells, or `undefined` when the feature is off. */
  onTierChange?: (channelExternalId: string, tier: SlackCapabilityTier) => void;
  /** Delete the channel's cells so the next cascade tier up wins. */
  onTierReset?: (channelExternalId: string) => void;
}

/** One channel-ID cell per non-guardian contact-type for the chosen tier. */
function cellsForTier(
  adapter: string,
  channelExternalId: string,
  tier: SlackCapabilityTier,
): WireCell[] {
  return CHANNEL_TIER_CONTACT_TYPES.map((contactType) => ({
    selector: { scope: "channel" as const, adapter, channelExternalId },
    contactType,
    threshold: tier,
  }));
}

function isChannelCell(
  cell: Cell,
  adapter: string,
  channelExternalId: string,
): boolean {
  return (
    cell.selector.scope === "channel" &&
    cell.selector.adapter === adapter &&
    cell.selector.channelExternalId === channelExternalId
  );
}

/**
 * Per-channel capabilities-tier persistence for a channel adapter's room
 * list: reads the gateway's channel-permission cells and writes/deletes
 * channel-ID-tier cells (one per non-guardian contact-type). Optimistic —
 * the cell cache is patched immediately, rolled back and toasted on
 * failure, and revalidated on settle. Reads the `channelTrustFloors` flag
 * itself; when off it returns no overrides and no handlers.
 *
 * The adapter is a parameter so Telegram/Phone room lists reuse this hook
 * unchanged when they land.
 */
export function useChannelPermissionOverrides({
  assistantId,
  adapter,
}: {
  assistantId: string;
  adapter: string;
}): ChannelPermissionOverridesController {
  const queryClient = useQueryClient();
  const enabled = useAssistantFeatureFlagStore.use.channelTrustFloors();

  const pathOptions = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const queryKey = useMemo(
    () => assistantChannelPermissionOverridesListQueryKey(pathOptions),
    [pathOptions],
  );

  const query = useQuery({
    ...assistantChannelPermissionOverridesListOptions(pathOptions),
    enabled: enabled && Boolean(assistantId),
    select: (data) => ({
      tierOverrides: tierOverridesFromCells(data.cells, adapter),
      typeDefaults: {
        public: defaultTierFromCells(data.cells, adapter, "public"),
        private: defaultTierFromCells(data.cells, adapter, "private"),
      },
    }),
  });

  // Optimistically replace the channel's cells in the cached list, snapshot
  // for rollback, and revalidate after the server settles either way.
  const applyOptimistic = (
    channelExternalId: string,
    nextCells: WireCell[],
  ): { previous: CellList | undefined } => {
    const previous = queryClient.getQueryData<CellList>(queryKey);
    const stampedAt = Date.now();
    queryClient.setQueryData<CellList>(queryKey, (old) => ({
      cells: [
        ...(old?.cells ?? []).filter(
          (cell) => !isChannelCell(cell, adapter, channelExternalId),
        ),
        ...nextCells.map((cell) => ({ ...cell, updatedAt: stampedAt })),
      ],
    }));
    return { previous };
  };

  const setMutation = useMutation({
    mutationFn: async ({
      channelExternalId,
      tier,
    }: {
      channelExternalId: string;
      tier: SlackCapabilityTier;
    }) => {
      await Promise.all(
        cellsForTier(adapter, channelExternalId, tier).map((cell) =>
          assistantChannelPermissionOverrideSet({
            ...pathOptions,
            body: cell,
            throwOnError: true,
          }),
        ),
      );
    },
    onMutate: ({ channelExternalId, tier }) =>
      applyOptimistic(
        channelExternalId,
        cellsForTier(adapter, channelExternalId, tier),
      ),
    onError: (err, _vars, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      toastOnError("Failed to save channel settings")(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: async ({
      channelExternalId,
    }: {
      channelExternalId: string;
    }) => {
      await Promise.all(
        CHANNEL_TIER_CONTACT_TYPES.map((contactType) =>
          assistantChannelPermissionOverrideDelete({
            ...pathOptions,
            body: {
              selector: {
                scope: "channel" as const,
                adapter,
                channelExternalId,
              },
              contactType,
            },
            throwOnError: true,
          }),
        ),
      );
    },
    onMutate: ({ channelExternalId }) =>
      applyOptimistic(channelExternalId, []),
    onError: (err, _vars, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      toastOnError("Failed to reset channel settings")(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const pendingChannelIds = useMemo(() => {
    const ids = new Set<string>();
    if (setMutation.isPending && setMutation.variables) {
      ids.add(setMutation.variables.channelExternalId);
    }
    if (deleteMutation.isPending && deleteMutation.variables) {
      ids.add(deleteMutation.variables.channelExternalId);
    }
    return ids;
  }, [
    setMutation.isPending,
    setMutation.variables,
    deleteMutation.isPending,
    deleteMutation.variables,
  ]);

  if (!enabled) {
    return {
      tierOverrides: undefined,
      typeDefaults: undefined,
      pendingChannelIds: new Set(),
      isLoading: false,
      isError: false,
      onTierChange: undefined,
      onTierReset: undefined,
    };
  }

  return {
    tierOverrides: query.data?.tierOverrides,
    typeDefaults: query.data?.typeDefaults,
    pendingChannelIds,
    isLoading: query.isPending,
    isError: query.isError,
    onTierChange: (channelExternalId, tier) =>
      setMutation.mutate({ channelExternalId, tier }),
    onTierReset: (channelExternalId) => {
      // Skip the round-trip when nothing is persisted for the channel.
      if (query.data?.tierOverrides[channelExternalId] === undefined) {
        return;
      }
      deleteMutation.mutate({ channelExternalId });
    },
  };
}
