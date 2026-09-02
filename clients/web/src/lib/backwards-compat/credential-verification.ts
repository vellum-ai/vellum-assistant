/**
 * Backwards-compat gate: on-demand managed-credential verification
 * (`POST /v1/platform/verify-credential`).
 *
 * The route asks the platform whether the assistant's stored managed
 * credential authenticates. The in-app repair for a rejected credential calls
 * it after rotating and storing a replacement, so that "repaired" means the
 * replacement works and not merely that the write landed.
 *
 * Old behavior (< MIN_VERSION): the route does not exist. The daemon answers
 * 404, which the caller would read as "could not confirm" and report as a
 * failure, for a repair that had already succeeded. Every such report invites
 * another rotation of a credential that is already fine. On the `false`
 * branch the repair therefore skips verification and treats the stored
 * replacement as the repair, which is what a repair meant on those daemons.
 *
 * New behavior (>= MIN_VERSION): the route exists and the repair confirms the
 * replacement before reporting success.
 *
 * The floor is the dev version of the commit that landed the route, per
 * BACKWARDS_COMPAT.md: nothing is predicted, every later release satisfies it,
 * and dev builds cut from `main` after that commit light up.
 */
import { assistantSupports, whenAssistantVersionKnown } from "./utils";

export const MIN_VERSION = "0.11.8-dev.202609011855.a4d8c71";

/**
 * Snapshot variant, for non-hook contexts. `false` while the version is
 * unhydrated, so a caller deciding whether to *skip* a check must use
 * {@link resolveSupportsCredentialVerification} instead: the conservative
 * default here would skip verification on a daemon that has it.
 */
export function supportsCredentialVerification(): boolean {
  return assistantSupports(MIN_VERSION);
}

/**
 * Write-path variant: waits (bounded) for the assistant version to hydrate,
 * then reads the gate against a resolved version.
 *
 * The repair runs this after it has stored the replacement, so the decision
 * it makes is whether to confirm that write. Deciding on the pre-hydration
 * `false` would silently drop the confirmation exactly when a fresh page load
 * is the thing that led the user to the repair.
 */
export async function resolveSupportsCredentialVerification(): Promise<boolean> {
  await whenAssistantVersionKnown();
  return supportsCredentialVerification();
}
