/**
 * Backwards-compat gate: `profile: "debug"` on `POST /v1/migrations/export-to-gcs`.
 *
 * Old behavior (< MIN_VERSION): the daemon's request schema does not know
 * `profile`, strips it, and builds a normal teleport bundle, which carries
 * the owner's credentials. Uploading that to the staff debug-bundle URL
 * would hand staff exactly what the debug profile exists to leave out, so
 * below the floor the export row must not offer the button at all.
 *
 * New behavior (>= MIN_VERSION): the daemon honors the profile, collects
 * no credentials, and adds the gateway's database and logs.
 *
 * MIN_VERSION is the release that shipped the profile (vellum-assistant
 * #43048 landed in v0.12.3).
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.12.3";

export function useSupportsDebugExportProfile(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
