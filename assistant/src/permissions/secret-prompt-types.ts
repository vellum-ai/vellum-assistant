/**
 * Result vocabulary for a secret prompt: how the value is delivered and the
 * outcome of the prompt. Kept in a leaf module (no runtime dependencies) so
 * type-only consumers can reference the shapes without importing the prompter
 * implementation and its daemon-internal dependencies.
 */

export type SecretDelivery = "store" | "transient_send";

export interface SecretPromptResult {
  value: string | null;
  delivery: SecretDelivery;
  /** When set, the prompt could not be delivered and the value is null due to a delivery failure (not user cancellation). */
  error?: "unsupported_channel";
  /**
   * Why `value` is null. `"cancelled"` = the user explicitly dismissed the
   * prompt (a valid flow, not a failure); `"timed_out"` = no response within
   * the permission-timeout window; `"superseded"` = a newer message in the
   * conversation auto-denied the pending prompt before anyone answered it.
   * Only meaningful when `value` is null and `error` is unset. Lets callers
   * distinguish a deliberate cancel from a genuine failure instead of
   * treating both as an error.
   */
  reason?: "cancelled" | "timed_out" | "superseded";
  /**
   * One-time collection URL minted when the channel cannot render the secure
   * prompt. Set together with `error: "unsupported_channel"` — the caller
   * relays the link so the user can supply the value out of band; the gateway
   * stores the submitted value via the credential vault.
   */
  collectionUrl?: string;
  /** Expiry (epoch ms) of {@link SecretPromptResult.collectionUrl}. */
  collectionExpiresAt?: number;
}
