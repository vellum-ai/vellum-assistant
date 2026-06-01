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
 * This lives in its own low-dependency module (types only) so both the
 * conversation lifecycle (history load) and the context compactor (image
 * manifest) can apply the identical filter without creating an import
 * cycle through `conversation-lifecycle` ↔ `window-manager` ↔ `compactor`.
 */
import type { MessageRow } from "../memory/conversation-crud.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";

export function parseProvenanceTrustClass(
  metadata: string | null,
): TrustClass | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata) as { provenanceTrustClass?: unknown };
    const trustClass = parsed?.provenanceTrustClass;
    if (
      trustClass === "guardian" ||
      trustClass === "trusted_contact" ||
      trustClass === "unknown"
    ) {
      return trustClass;
    }
  } catch {
    // Ignore malformed metadata and treat as unknown provenance.
  }
  return undefined;
}

export function filterMessagesForUntrustedActor(
  messages: MessageRow[],
): MessageRow[] {
  return messages.filter((m) => {
    const provenanceTrustClass = parseProvenanceTrustClass(m.metadata);
    return (
      provenanceTrustClass === "trusted_contact" ||
      provenanceTrustClass === "unknown"
    );
  });
}
