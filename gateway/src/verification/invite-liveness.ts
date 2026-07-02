/**
 * Shared invite liveness gate: status + expiry validation with lazy expiry
 * sweeping against the gateway-canonical `ingress_invites` row.
 */

import type { ContactStore, IngressInviteRow } from "../db/contact-store.js";

export type InviteLiveness =
  /** Active and unexpired. */
  | { live: true }
  /** Already terminal (expired / revoked / redeemed). */
  | { live: false; reason: "terminal"; status: string }
  /** Active but past expiry — lazily flipped to status "expired". */
  | { live: false; reason: "expired"; status: "expired" };

/**
 * Check that an invite is live (status "active" and unexpired). An active
 * row past its expiry is lazily marked expired as a side effect.
 */
export function ensureInviteLive(
  store: ContactStore,
  invite: IngressInviteRow,
  now: number = Date.now(),
): InviteLiveness {
  if (invite.status !== "active") {
    return { live: false, reason: "terminal", status: invite.status };
  }
  if (invite.expiresAt <= now) {
    store.markInviteExpired(invite.id);
    return { live: false, reason: "expired", status: "expired" };
  }
  return { live: true };
}
