import type { DisplayAttachment } from "@/types/attachment-types";

export interface FailedSendRecoveryPayload {
  content: string;
  attachments: DisplayAttachment[];
}

export interface CorrelatedFailedSend<
  Payload extends FailedSendRecoveryPayload,
> {
  payload: Payload;
  clientMessageId?: string;
}

export interface ClaimedFailedSendBatch<
  Payload extends FailedSendRecoveryPayload,
> {
  entries: readonly CorrelatedFailedSend<Payload>[];
}

export interface ClaimedFailedSendTransition<
  Payload extends FailedSendRecoveryPayload,
> {
  key: string;
  before: Payload;
  after: Payload | null;
  wasActiveBatch: boolean;
}

/** Merge a recovery batch in send order while preserving its scoped fields. */
export function mergeFailedSendEntries<
  Payload extends FailedSendRecoveryPayload,
>(entries: readonly CorrelatedFailedSend<Payload>[]): Payload {
  const cached = mergedFailedSendCache.get(entries) as Payload | undefined;
  if (cached !== undefined) {
    return cached;
  }
  const first = entries[0];
  if (first === undefined) {
    throw new Error("Cannot merge an empty failed-send batch");
  }
  const merged = {
    ...first.payload,
    content: entries
      .map((entry) => entry.payload.content)
      .filter((content) => content !== "")
      .join("\n\n"),
    attachments: entries.flatMap((entry) => entry.payload.attachments),
  };
  mergedFailedSendCache.set(entries, merged);
  return merged;
}

const mergedFailedSendCache = new WeakMap<
  readonly object[],
  FailedSendRecoveryPayload
>();

/** Append one shown recovery batch under the composer scope that claimed it. */
export function claimFailedSendBatch<
  Payload extends FailedSendRecoveryPayload,
>(
  claimed: ReadonlyMap<
    string,
    readonly ClaimedFailedSendBatch<Payload>[]
  >,
  key: string,
  entries: readonly CorrelatedFailedSend<Payload>[],
): ReadonlyMap<string, readonly ClaimedFailedSendBatch<Payload>[]> {
  if (!entries.some((entry) => entry.clientMessageId !== undefined)) {
    return claimed;
  }
  const next = new Map(claimed);
  next.set(key, [...(claimed.get(key) ?? []), { entries }]);
  return next;
}

/** Whether a shown recovery batch still contains the send carrying `nonce`. */
export function hasClaimedFailedSend<
  Payload extends FailedSendRecoveryPayload,
>(
  claimed: ReadonlyMap<
    string,
    readonly ClaimedFailedSendBatch<Payload>[]
  >,
  nonce: string,
): boolean {
  return [...claimed.values()].some((batches) =>
    batches.some((batch) =>
      batch.entries.some((entry) => entry.clientMessageId === nonce),
    ),
  );
}

/**
 * Settle one component of a shown recovery batch.
 *
 * An accepted component is removed from the visible batch. A failed component
 * stays visible but loses its nonce, so later accepted siblings can still be
 * subtracted from the complete payload the composer currently shows.
 */
export function settleClaimedFailedSendBatch<
  Payload extends FailedSendRecoveryPayload,
>(
  claimed: ReadonlyMap<
    string,
    readonly ClaimedFailedSendBatch<Payload>[]
  >,
  clientMessageId: string,
  outcome: "accepted" | "failed",
): {
  claimed: ReadonlyMap<string, readonly ClaimedFailedSendBatch<Payload>[]>;
  transition: ClaimedFailedSendTransition<Payload>;
} | null {
  const match = [...claimed].find(([, batches]) =>
    batches.some((batch) =>
      batch.entries.some(
        (entry) => entry.clientMessageId === clientMessageId,
      ),
    ),
  );
  if (match === undefined) {
    return null;
  }
  const [key, batches] = match;
  const batchIndex = batches.findIndex((batch) =>
    batch.entries.some(
      (entry) => entry.clientMessageId === clientMessageId,
    ),
  );
  const batch = batches[batchIndex];
  const before = mergeFailedSendEntries(batch.entries);
  const remaining =
    outcome === "accepted"
      ? batch.entries.filter(
          (entry) => entry.clientMessageId !== clientMessageId,
        )
      : batch.entries.map((entry) =>
          entry.clientMessageId === clientMessageId
            ? { payload: entry.payload }
            : entry,
        );
  const after =
    remaining.length === 0 ? null : mergeFailedSendEntries(remaining);
  const next = new Map(claimed);
  const nextBatches = [...batches];
  if (remaining.some((entry) => entry.clientMessageId !== undefined)) {
    nextBatches[batchIndex] = { entries: remaining };
  } else {
    nextBatches.splice(batchIndex, 1);
  }
  if (nextBatches.length === 0) {
    next.delete(key);
  } else {
    next.set(key, nextBatches);
  }
  return {
    claimed: next,
    transition: {
      key,
      before,
      after,
      wasActiveBatch: batchIndex === batches.length - 1,
    },
  };
}
