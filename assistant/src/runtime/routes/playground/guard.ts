import { httpError } from "../../http-errors.js";
import type { PlaygroundRouteDeps } from "./deps.js";

/**
 * Defense-in-depth guard every playground route calls first. Returns a 404
 * Response when the `compaction-playground` feature flag is disabled so the
 * entire /playground/* surface is invisible in production regardless of UI
 * gating.
 */
export function assertPlaygroundEnabled(
  deps: PlaygroundRouteDeps,
): Response | null {
  if (!deps.isPlaygroundEnabled()) {
    return httpError("NOT_FOUND", "Not found", 404);
  }
  return null;
}
