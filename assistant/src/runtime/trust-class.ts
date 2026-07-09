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

/**
 * Whether a trust class names a known non-guardian contact — the
 * `trusted_contact` / `unverified_contact` pair whose admission-only
 * equivalence is documented on {@link trustClassSchema}.
 *
 * Accepts a raw string (not just `TrustClass`) because several call sites
 * classify trust classes read back from persisted turn metadata, which may
 * carry legacy or foreign values; anything outside the pair — including
 * `undefined` — is not a contact.
 */
export function isContactTrustClass(
  trustClass: string | undefined,
): trustClass is "trusted_contact" | "unverified_contact" {
  return (
    trustClass === "trusted_contact" || trustClass === "unverified_contact"
  );
}

/**
 * Persona-facing view of a trust class, precomputed as booleans because the
 * system-prompt mustache renderer only does truthy section gating, not string
 * comparison. Exactly one flag is true per class; `trustClass` is the resolved
 * class the flags were derived from.
 */
export interface PersonaTrustFlags {
  trustClass: TrustClass;
  isGuardian: boolean;
  isTrustedContact: boolean;
  isStranger: boolean;
}

/**
 * Derive the persona/prompt-gating flags for an actor's trust class — the one
 * home for how persona/prompt surfaces (notably `users/default.md`, the
 * persona rendered for non-guardian actors) classify who is being spoken to.
 *
 * - An absent class (unresolved actor) derives as `stranger`. This is
 *   deliberately NOT `resolveTrustClass()`: that helper fail-safes an
 *   unresolved turn to `guardian` under the local auth-bypass so control-plane
 *   capability gates don't block local development. A data-disclosure boundary
 *   needs the opposite default — fail closed, so a turn that never resolved an
 *   actor still renders the guardrail rather than a guardian exemption.
 * - `unverified_contact` derives identically to `trusted_contact`, making the
 *   admission-only equivalence documented on {@link trustClassSchema}
 *   executable in one place.
 * - The switch is exhaustive with no default: adding a `TrustClass` member is a
 *   compile error here, forcing a deliberate persona decision for the new
 *   class.
 *
 * Scope: prompt/persona rendering only — the *data-disclosure* boundary. Its
 * complement, identity/verification hygiene, is `promptTrustGuidance` in
 * `resolveCapabilities()` (rendered by
 * `plugins/defaults/turn-context/unified-turn-context.ts`); capability and tool
 * gating must keep using `resolveCapabilities()` / `resolveTrustClass()`.
 */
export function derivePersonaTrustFlags(
  trustClass: TrustClass | undefined,
): PersonaTrustFlags {
  const resolved: TrustClass = trustClass ?? "unknown";
  switch (resolved) {
    case "guardian": {
      return {
        trustClass: resolved,
        isGuardian: true,
        isTrustedContact: false,
        isStranger: false,
      };
    }
    case "trusted_contact":
    case "unverified_contact": {
      return {
        trustClass: resolved,
        isGuardian: false,
        isTrustedContact: true,
        isStranger: false,
      };
    }
    case "unknown": {
      return {
        trustClass: resolved,
        isGuardian: false,
        isTrustedContact: false,
        isStranger: true,
      };
    }
  }
}
