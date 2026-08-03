/**
 * Shared optimistic-write engine for the speech pickers (`use-managed-voice-
 * selection`, `use-stt-language-selection`). Each picker persists one config
 * value via `config_patch` and needs the same write discipline, so it lives
 * here once: an optimistic pending value, serialized writes, a latest-write
 * guard, config invalidation, and a failure toast.
 *
 * The caller keeps ownership of everything value-shaped: how the configured
 * value is derived from config, what body a value patches to, and the
 * failure copy. This hook only owns the write lifecycle.
 */

import { useCallback, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch } from "@/generated/daemon/sdk.gen";

type ConfigPatchBody = NonNullable<Parameters<typeof configPatch>[0]>["body"];

export interface UseSerializedConfigSelection {
  /**
   * The currently-selected value: the pick a write is still carrying, else
   * the caller's `configuredValue`. Holding the pick until its write has
   * landed keeps the surface responsive: a check mark that waits out a round
   * trip reads as a dropped click.
   */
  currentValue: string;
  /** A write is in flight. Stays true until the newest one settles. */
  selecting: boolean;
  /**
   * Persist a value. Safe to call again before the last one lands, writes
   * are serialized in call order. A pick equal to `currentValue` is a no-op.
   */
  select: (value: string) => void;
}

export function useSerializedConfigSelection({
  assistantId,
  configuredValue,
  buildPatchBody,
  failureMessage,
}: {
  assistantId: string | null;
  /**
   * The caller's config-derived value (config field, defaults, display
   * normalization). `currentValue` reads as this whenever no pick is in
   * flight.
   */
  configuredValue: string;
  /**
   * Maps a picked value to the `config_patch` body that persists it. Must be
   * referentially stable (module-level or memoized) so `select` identity only
   * tracks real state.
   */
  buildPatchBody: (value: string) => ConfigPatchBody;
  /** Toast copy shown when a write fails or rejects. */
  failureMessage: string;
}): UseSerializedConfigSelection {
  const queryClient = useQueryClient();

  const [selecting, setSelecting] = useState(false);
  // The value a pick is heading for, held until its write has landed in
  // config.
  const [pendingValue, setPendingValue] = useState<string | null>(null);

  const currentValue = pendingValue ?? configuredValue;

  // Writes run one at a time in click order, and only the newest one settles
  // the UI. Concurrent PATCHes of the same config field can arrive out of
  // order: config would then keep whichever landed last rather than what was
  // clicked last, and the first response back would clear `selecting` while
  // a later write was still in flight.
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const latestWrite = useRef(0);

  const select = useCallback(
    (value: string) => {
      if (!assistantId || value === currentValue) {
        return;
      }
      const seq = ++latestWrite.current;
      setPendingValue(value);
      setSelecting(true);
      writeChain.current = writeChain.current.then(async () => {
        try {
          const { response } = await configPatch({
            path: { assistant_id: assistantId },
            body: buildPatchBody(value),
            throwOnError: false,
          });
          if (!response?.ok) {
            toast.error(failureMessage);
            return;
          }
          // Refetch config so `currentValue` reflects the write. The running
          // session picks the new value up from config on its next turn.
          await queryClient.invalidateQueries({
            queryKey: configGetQueryKey({
              path: { assistant_id: assistantId },
            }),
          });
        } catch {
          toast.error(failureMessage);
        } finally {
          // Superseded writes leave the state alone: the pick they'd revert
          // to is not the one the user is waiting on. Dropping the pending
          // value here also reverts a failed write to whatever config holds.
          if (seq === latestWrite.current) {
            setPendingValue(null);
            setSelecting(false);
          }
        }
      });
    },
    [assistantId, currentValue, buildPatchBody, failureMessage, queryClient],
  );

  return { currentValue, selecting, select };
}
