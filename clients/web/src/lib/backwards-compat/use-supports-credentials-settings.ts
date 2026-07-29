/**
 * Backwards-compat gate: the Credentials settings surface.
 *
 * The Credentials settings page (stored-credential list with managed
 * credentials, add/delete, one-time credential-request links) and its
 * daemon-side routes — the `credentials/list` shape the page renders and the
 * `credential-requests` mint route — first ship in assistant 0.10.8
 * (PR #37493, merged 2026-07-08). Against an older assistant the page would
 * render a dead error state and the generate-link action would 404, so the
 * web app hides the Settings → Credentials tab and the page renders NotFound
 * on direct navigation.
 *
 * Scoped to the owning assistant via `useAssistantScopedSupports` — see its
 * JSDoc in `./utils.ts` for the atomic version+owner snapshot and
 * conservative unknown/mismatch semantics — so a version fetched for one
 * assistant never authorizes another's routes mid-switch.
 */
import { useAssistantScopedSupports } from "./utils";

const MIN_VERSION = "0.10.8";

/**
 * Returns `true` when the assistant that owns the settings surface
 * (`ownerAssistantId` — the active assistant whose Settings are rendered) is
 * new enough to serve the credentials-page routes. Conservative (`false`)
 * until the scoped version hydrates and on any owner mismatch, so the
 * Credentials tab stays hidden and the page renders nothing.
 */
export function useSupportsCredentialsSettings(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
