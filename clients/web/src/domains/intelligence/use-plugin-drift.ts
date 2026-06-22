import { useQuery } from "@tanstack/react-query";

import { pluginsByNameInspectGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginsByNameInspectGetResponse } from "@/generated/daemon/types.gen";

/**
 * Drift between the installed plugin copy and the marketplace pin, plus the
 * local-edit state of the installed copy. `null` until the inspect query
 * resolves (or when it fails — e.g. an older daemon without the route).
 */
export type PluginDrift = PluginsByNameInspectGetResponse;

// `inspect` re-fetches the marketplace catalog and re-hashes the on-disk copy,
// so it is far heavier than a list read. A generous stale window keeps the
// result warm across the detail page and the list row (which share this query
// via the generated key) so revisiting or hovering doesn't re-run it.
const DRIFT_STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

interface UsePluginDriftArgs {
  assistantId: string;
  name: string;
  /**
   * Gate the query so callers can avoid inspecting plugins that can't drift
   * (e.g. ones that aren't installed). Defaults to `true`.
   */
  enabled?: boolean;
}

/**
 * Shared data hook for a single plugin's update-drift signal.
 *
 * Wraps the daemon `plugins/:name/inspect` route. The query is keyed by the
 * generated SDK key, so the plugin detail header and the list row resolve the
 * same cached inspection rather than each issuing their own marketplace fetch.
 *
 * Failures degrade silently to "no drift info" (`data` stays `undefined`): an
 * older daemon without the route answers 404, and the only consumers gate UI
 * (the Upgrade button / "Update available" badge) on a positive
 * `update-available` status — so a missing inspection simply hides the
 * affordance instead of surfacing an error.
 */
export function usePluginDrift({
  assistantId,
  name,
  enabled = true,
}: UsePluginDriftArgs) {
  return useQuery({
    ...pluginsByNameInspectGetOptions({
      path: { assistant_id: assistantId, name },
    }),
    enabled: Boolean(assistantId) && Boolean(name) && enabled,
    staleTime: DRIFT_STALE_TIME_MS,
    retry: false,
  });
}

/** True when the installed copy has uncommitted local edits vs its baseline. */
export function hasLocalEdits(drift: PluginDrift | undefined): boolean {
  const localChanges = drift?.local?.localChanges;
  return Boolean(localChanges) && localChanges?.clean === false;
}
