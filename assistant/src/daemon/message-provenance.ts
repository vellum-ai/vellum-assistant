/**
 * Provenance-based message trust filtering.
 *
 * Each persisted message row records the trust class of the actor that
 * produced it under `metadata.provenanceTrustClass`. Untrusted actors
 * (unknown / trusted_contact viewers) must never see content that
 * originated from the guardian, so any view assembled for an untrusted
 * actor filters the history down to rows whose provenance is itself
 * non-guardian.
 *
 * This lives in its own low-dependency module (types plus the zod-only
 * trust-class leaf) so both the conversation lifecycle (history load) and the
 * context compactor (image manifest) can apply the identical filter without
 * creating an import cycle through `conversation-lifecycle` ↔
 * `window-manager` ↔ `compactor`.
 *
 * It also owns the author field (`actorAuthorProvenance`), which says who
 * wrote a row rather than whose turn wrote it.
 */
import type { MessageRow } from "../persistence/conversation-crud.js";
import { type TrustClass, trustClassSchema } from "../runtime/trust-class.js";
import type { TrustContext } from "./trust-context-types.js";

export function parseProvenanceTrustClass(
  metadata: string | null,
): TrustClass | undefined {
  if (!metadata) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(metadata) as { provenanceTrustClass?: unknown };
    const result = trustClassSchema.safeParse(parsed?.provenanceTrustClass);
    if (result.success) {
      return result.data;
    }
  } catch {
    // Ignore malformed metadata and treat as unknown provenance.
  }
  return undefined;
}

/**
 * Per-row form of {@link filterMessagesForUntrustedActor}: whether a single
 * persisted row's provenance is visible to an untrusted (non-guardian)
 * actor view. Exported so consumers that scan raw rows outside a full
 * history load (e.g. the persisted-surface fallback in the surface routes)
 * apply the identical predicate instead of duplicating the allowlist.
 */
export function isRowVisibleToUntrustedActor(metadata: string | null): boolean {
  const provenanceTrustClass = parseProvenanceTrustClass(metadata);
  return (
    provenanceTrustClass === "trusted_contact" ||
    provenanceTrustClass === "unverified_contact" ||
    provenanceTrustClass === "unknown"
  );
}

export function filterMessagesForUntrustedActor(
  messages: MessageRow[],
): MessageRow[] {
  return messages.filter((m) => isRowVisibleToUntrustedActor(m.metadata));
}

/** The persisted author field: the contact who wrote the row. */
export interface ActorAuthorProvenance {
  provenanceContactId?: string;
}

/**
 * Author fields for a row the trust context's actor wrote themselves: their
 * own message or reaction. `provenanceFromTrustContext` describes the turn and
 * is also stamped on the assistant's replies, tool results, and notices, so
 * those rows must never carry these.
 */
export function actorAuthorProvenance(
  trustContext: TrustContext | undefined,
): ActorAuthorProvenance {
  return trustContext?.requesterContactId
    ? { provenanceContactId: trustContext.requesterContactId }
    : {};
}
