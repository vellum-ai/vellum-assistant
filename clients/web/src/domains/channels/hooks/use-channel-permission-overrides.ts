import { useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  bucketDefaultFromCells,
  CHANNEL_TIER_CONTACT_TYPES,
  isBucketCell,
  tierOverridesFromCells,
  type ChannelDefaultBucket,
} from "@/domains/channels/slack-channel-overrides";
import type { RiskThreshold } from "@/utils/threshold-presets";
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
type Selector = Cell["selector"];

export interface ChannelPermissionOverridesController {
  /**
   * False when the connected assistant predates the gateway's
   * channel-permission routes — the caller renders without access
   * controls instead of a dead error state.
   */
  supported: boolean;
  /** Persisted tier per channel external id, or `undefined` while unsupported. */
  tierOverrides?: Record<string, RiskThreshold>;
  /**
   * The gateway-resolved default for cell-less rooms: the winning
   * broader-scope cell's threshold, queried with the same coordinates the
   * runtime evaluator uses for this adapter's rooms (no conversation
   * type). `null` when no cell matches (the global thresholds apply);
   * `undefined` while loading or unsupported.
   */
  defaultCellTier?: RiskThreshold | null;
  /**
   * The explicit tier for a channel-type default bucket, or `undefined` when the
   * bucket has no cell (it follows the next tier up). `channels` is the
   * adapter-scope default; `dm` is the direct-message default.
   */
  bucketTiers?: Record<ChannelDefaultBucket, RiskThreshold | undefined>;
  /** Channels with a cell write/delete in flight. */
  pendingChannelIds: ReadonlySet<string>;
  /** Buckets with a default write/delete in flight. */
  pendingBuckets: ReadonlySet<ChannelDefaultBucket>;
  /** True until the cells have loaded at least once. */
  isLoading: boolean;
  isError: boolean;
  /** Persist a tier as channel-ID cells, or `undefined` while unsupported. */
  onTierChange?: (channelExternalId: string, tier: RiskThreshold) => void;
  /** Delete the channel's cells so the next cascade tier up wins. */
  onTierReset?: (channelExternalId: string) => void;
  /** Persist a channel-type default bucket's cells. */
  onBucketChange?: (bucket: ChannelDefaultBucket, tier: RiskThreshold) => void;
  /** Delete a bucket's cells so it follows the next tier up. */
  onBucketReset?: (bucket: ChannelDefaultBucket) => void;
}

/** One channel-ID cell per non-guardian contact-type for the chosen tier. */
function cellsForTier(
  adapter: string,
  channelExternalId: string,
  tier: RiskThreshold,
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

/** The selector for a channel-type default bucket: adapter-scope or channel_type:dm. */
function bucketSelector(adapter: string, bucket: ChannelDefaultBucket): Selector {
  return bucket === "channels"
    ? { scope: "adapter", adapter }
    : { scope: "channel_type", adapter, channelType: "dm" };
}

/** One bucket cell per non-guardian contact-type for the chosen tier. */
function cellsForBucket(
  adapter: string,
  bucket: ChannelDefaultBucket,
  tier: RiskThreshold,
): WireCell[] {
  const selector = bucketSelector(adapter, bucket);
  return CHANNEL_TIER_CONTACT_TYPES.map((contactType) => ({
    selector,
    contactType,
    threshold: tier,
  }));
}

/**
 * Per-channel capabilities-tier persistence for a channel adapter's room
 * list: reads the gateway's channel-permission cells and writes/deletes
 * channel-ID-tier cells (one per non-guardian contact-type), plus the two
 * broader-scope default buckets (`channels` → adapter cell, `dm` →
 * channel_type:dm cell). Optimistic — the cell cache is patched immediately,
 * rolled back and toasted on failure, and revalidated on settle. Gated on the
 * version gate in `lib/backwards-compat/channel-access-controls.ts` (whether the
 * connected assistant can serve it); when off it reports `supported: false` with
 * no overrides or handlers.
 *
 * `adapter` filters the gateway's cell list, which returns every adapter's
 * cells (only caller today is Slack).
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
  // The resolve query (the cell-less fall-through) is keyed separately and
  // caches for 30s. A `channels`-bucket write changes an adapter-scope cell,
  // which the resolve reads — so bucket writes must invalidate it too, or the
  // per-channel rows keep their stale `defaultTier`.
  const resolveQueryKey = useMemo(
    () => ["channel-permission-resolve", assistantId, adapter] as const,
    [assistantId, adapter],
  );

  const query = useQuery({
    ...assistantChannelPermissionOverridesListOptions(pathOptions),
    enabled,
  });

  const cells = query.data?.cells;
  const tierOverrides = useMemo(
    () => (cells ? tierOverridesFromCells(cells, adapter) : undefined),
    [cells, adapter],
  );
  const bucketTiers = useMemo<
    Record<ChannelDefaultBucket, RiskThreshold | undefined> | undefined
  >(
    () =>
      cells
        ? {
            channels: bucketDefaultFromCells(cells, adapter, "channels"),
            dm: bucketDefaultFromCells(cells, adapter, "dm"),
          }
        : undefined,
    [cells, adapter],
  );

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
    queryKey: resolveQueryKey,
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

  // Optimistically replace the cells matching `matches` in the cached list,
  // snapshot for rollback, and revalidate after the server settles either way.
  const applyOptimistic = (
    matches: (cell: Cell) => boolean,
    nextCells: WireCell[],
  ): { previous: CellList | undefined } => {
    const previous = queryClient.getQueryData<CellList>(queryKey);
    const stampedAt = Date.now();
    queryClient.setQueryData<CellList>(queryKey, (old) => ({
      cells: [
        ...(old?.cells ?? []).filter((cell) => !matches(cell)),
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
      tier: RiskThreshold;
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
        (cell) => isChannelCell(cell, adapter, channelExternalId),
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
      applyOptimistic(
        (cell) => isChannelCell(cell, adapter, channelExternalId),
        [],
      ),
    onError: (err, _vars, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      toastOnError("Failed to reset channel settings")(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const bucketSetMutation = useMutation({
    mutationFn: async ({
      bucket,
      tier,
    }: {
      bucket: ChannelDefaultBucket;
      tier: RiskThreshold;
    }) => {
      await Promise.all(
        cellsForBucket(adapter, bucket, tier).map((cell) =>
          assistantChannelPermissionOverrideSet({
            ...pathOptions,
            body: cell,
            throwOnError: true,
          }),
        ),
      );
    },
    onMutate: ({ bucket, tier }) =>
      applyOptimistic(
        (cell) => isBucketCell(cell, adapter, bucket),
        cellsForBucket(adapter, bucket, tier),
      ),
    onError: (err, _vars, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      toastOnError("Failed to save the default")(err);
    },
    onSettled: (_data, _err, { bucket }) => {
      queryClient.invalidateQueries({ queryKey });
      // Only the adapter-scope `channels` cell feeds the resolve query; a `dm`
      // write leaves the room-list fall-through unchanged.
      if (bucket === "channels") {
        queryClient.invalidateQueries({ queryKey: resolveQueryKey });
      }
    },
  });

  const bucketDeleteMutation = useMutation({
    mutationFn: async ({ bucket }: { bucket: ChannelDefaultBucket }) => {
      const selector = bucketSelector(adapter, bucket);
      await Promise.all(
        CHANNEL_TIER_CONTACT_TYPES.map((contactType) =>
          assistantChannelPermissionOverrideDelete({
            ...pathOptions,
            body: { selector, contactType },
            throwOnError: true,
          }),
        ),
      );
    },
    onMutate: ({ bucket }) =>
      applyOptimistic((cell) => isBucketCell(cell, adapter, bucket), []),
    onError: (err, _vars, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      toastOnError("Failed to reset the default")(err);
    },
    onSettled: (_data, _err, { bucket }) => {
      queryClient.invalidateQueries({ queryKey });
      // Only the adapter-scope `channels` cell feeds the resolve query; a `dm`
      // reset leaves the room-list fall-through unchanged.
      if (bucket === "channels") {
        queryClient.invalidateQueries({ queryKey: resolveQueryKey });
      }
    },
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

  const pendingBuckets = useMemo(() => {
    const buckets = new Set<ChannelDefaultBucket>();
    if (bucketSetMutation.isPending && bucketSetMutation.variables) {
      buckets.add(bucketSetMutation.variables.bucket);
    }
    if (bucketDeleteMutation.isPending && bucketDeleteMutation.variables) {
      buckets.add(bucketDeleteMutation.variables.bucket);
    }
    return buckets;
  }, [
    bucketSetMutation.isPending,
    bucketSetMutation.variables,
    bucketDeleteMutation.isPending,
    bucketDeleteMutation.variables,
  ]);

  // The version gate can't know whether *this* assistant's gateway actually
  // wired up the channel-permission routes — a build that reports a supported
  // version but still 404s the list route would otherwise leave the pickers
  // permanently disabled (they hold disabled until overrides load, which never
  // happens). Treat a list-route error like an unsupported assistant and
  // degrade to the read-only channel list, the same fall-back the version gate
  // uses. A 404 won't recover on retry; a transient error self-heals on the
  // query's next refetch, flipping this back to supported.
  if (!enabled || query.isError) {
    return {
      supported: false,
      tierOverrides: undefined,
      defaultCellTier: undefined,
      bucketTiers: undefined,
      pendingChannelIds: new Set(),
      pendingBuckets: new Set(),
      isLoading: false,
      isError: false,
      onTierChange: undefined,
      onTierReset: undefined,
      onBucketChange: undefined,
      onBucketReset: undefined,
    };
  }

  return {
    supported: true,
    tierOverrides,
    defaultCellTier: defaultQuery.data,
    bucketTiers,
    pendingChannelIds,
    pendingBuckets,
    isLoading: query.isPending,
    isError: query.isError,
    onTierChange: (channelExternalId, tier) =>
      setMutation.mutate({ channelExternalId, tier }),
    onTierReset: (channelExternalId) => {
      // Skip the round-trip when nothing is persisted for the channel.
      if (tierOverrides?.[channelExternalId] === undefined) {
        return;
      }
      deleteMutation.mutate({ channelExternalId });
    },
    onBucketChange: (bucket, tier) => bucketSetMutation.mutate({ bucket, tier }),
    onBucketReset: (bucket) => {
      // Skip the round-trip when the bucket has no cell.
      if (bucketTiers?.[bucket] === undefined) {
        return;
      }
      bucketDeleteMutation.mutate({ bucket });
    },
  };
}
