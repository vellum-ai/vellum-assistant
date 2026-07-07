import { useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  CHANNEL_TIER_CONTACT_TYPES,
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
  assistantChannelPermissionResolve,
} from "@/generated/gateway/sdk.gen";
import type { AssistantChannelPermissionOverridesListResponse } from "@/generated/gateway/types.gen";
import { useSupportsChannelAccessControls } from "@/lib/backwards-compat/channel-access-controls";
import { toastOnError } from "@/utils/mutation-error";

type CellList = AssistantChannelPermissionOverridesListResponse;
type Cell = CellList["cells"][number];
type WireCell = Omit<Cell, "updatedAt">;

export interface ChannelPermissionOverridesController {
  /**
   * False when the connected assistant predates the gateway's
   * channel-permission routes — the caller renders without access
   * controls instead of a dead error state.
   */
  supported: boolean;
  /** Persisted tier per channel external id, or `undefined` while unsupported. */
  tierOverrides?: Record<string, SlackCapabilityTier>;
  /**
   * The gateway-resolved default for cell-less rooms: the winning
   * broader-scope cell's threshold, queried with the same coordinates the
   * runtime evaluator uses for this adapter's rooms (no conversation
   * type). `null` when no cell matches (the global thresholds apply);
   * `undefined` while loading or unsupported.
   */
  defaultCellTier?: SlackCapabilityTier | null;
  /** Channels with a cell write/delete in flight. */
  pendingChannelIds: ReadonlySet<string>;
  /** True until the cells have loaded at least once. */
  isLoading: boolean;
  isError: boolean;
  /** Persist a tier as channel-ID cells, or `undefined` while unsupported. */
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
 * failure, and revalidated on settle. Version-gated itself (see
 * `lib/backwards-compat/channel-access-controls.ts`); against an older
 * assistant it reports `supported: false` with no overrides or handlers.
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
  const supported = useSupportsChannelAccessControls();
  const enabled = supported && Boolean(assistantId);

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
    enabled,
    select: (data) => tierOverridesFromCells(data.cells, adapter),
  });

  // The default a cell-less room falls through to, resolved by the gateway
  // (the same resolver the runtime evaluator uses over IPC) with the same
  // coordinates the evaluator queries for this adapter's rooms — no
  // conversation type, so broader-scope cells apply exactly as they would
  // at tool time. POST-with-body read; the generated SDK has no query
  // factory for it, so the queryFn calls the SDK directly. Fail-soft with
  // no retries: the resolve route ships after the rest of the surface
  // (0.10.7 gateways 404 it deterministically), and an errored query just
  // leaves the badge at a plain "Default".
  const defaultQuery = useQuery({
    queryKey: ["channel-permission-resolve", assistantId, adapter],
    queryFn: async () => {
      const { data } = await assistantChannelPermissionResolve({
        ...pathOptions,
        body: { adapter, contactType: "trusted_contact" },
        throwOnError: true,
      });
      return data.resolved?.threshold ?? null;
    },
    enabled,
    retry: false,
    staleTime: 30_000,
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
      supported: false,
      tierOverrides: undefined,
      defaultCellTier: undefined,
      pendingChannelIds: new Set(),
      isLoading: false,
      isError: false,
      onTierChange: undefined,
      onTierReset: undefined,
    };
  }

  return {
    supported: true,
    tierOverrides: query.data,
    defaultCellTier: defaultQuery.data,
    pendingChannelIds,
    isLoading: query.isPending,
    isError: query.isError,
    onTierChange: (channelExternalId, tier) =>
      setMutation.mutate({ channelExternalId, tier }),
    onTierReset: (channelExternalId) => {
      // Skip the round-trip when nothing is persisted for the channel.
      if (query.data?.[channelExternalId] === undefined) {
        return;
      }
      deleteMutation.mutate({ channelExternalId });
    },
  };
}
