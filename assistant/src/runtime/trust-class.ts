/**
 * Trust classification for an inbound actor — the single source of truth for
 * both the {@link TrustClass} type and the Zod enum ({@link trustClassSchema})
 * that validates it in persisted message metadata.
 *
 * Kept as a leaf module (imports only `zod`) so the runtime trust layer and the
 * persistence schema can share one definition without a circular import.
 *
 * - `'guardian'`: The sender matches the active guardian binding for this
 *   (assistant, channel). Guardians have full control-plane access and
 *   self-approve tool invocations.
 * - `'trusted_contact'`: The sender is an active contact with a channel
 *   (not the guardian). Trusted contacts can invoke tools but require
 *   guardian approval for sensitive operations.
 * - `'unverified_contact'`: The sender matches a contact channel whose
 *   status is `pending` or `unverified` — known to the guardian but not yet
 *   verified. Treated identically to `trusted_contact` for every downstream
 *   capability/tool/approval decision; the distinction is admission-only.
 * - `'unknown'`: The sender has no contact record, no identity could be
 *   established, or the sender is a blocked/revoked contact. Unknown
 *   actors are fail-closed with no escalation path.
 */

import { z } from "zod";

export const trustClassSchema = z.enum([
  "guardian",
  "trusted_contact",
  "unverified_contact",
  "unknown",
]);

export type TrustClass = z.infer<typeof trustClassSchema>;
