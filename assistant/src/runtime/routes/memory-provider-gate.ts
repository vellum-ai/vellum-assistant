/**
 * Shared guard that gates provider-specific memory routes on the active memory
 * system.
 *
 * The memory v2/v3 maintenance routes live in the shared `ROUTES` array and are
 * always registered, but a route that drives the v2 concept-page system must
 * not execute when the active provider is v3 (and vice versa) — running a
 * maintenance verb against an inactive system would act on stale or empty
 * state. Each provider-owned handler calls {@link requireActiveMemoryProvider}
 * with its own id; when a different provider is active the request is rejected
 * with a clean not-applicable {@link RouteError} (404) instead of a 500 from
 * executing against the wrong system.
 */

import { loadConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { resolveMemoryProviderId } from "../../memory/provider/provider-id.js";
import type { MemoryProviderId } from "../../memory/provider/types.js";
import { RouteError } from "./errors.js";

/**
 * Wire-format error code emitted when a provider-specific memory route is hit
 * while a different memory provider is active. Exported so tests and clients
 * reference the same string without drift.
 */
export const MEMORY_PROVIDER_NOT_ACTIVE_CODE = "MEMORY_PROVIDER_NOT_ACTIVE";

/**
 * Reject the request when `provider` is not the active memory system.
 *
 * Returns a 404 (not 500): from the client's perspective the endpoint does not
 * apply to the running configuration, so it is "not found for this provider"
 * rather than a server fault. The desktop Memories surface reads the code to
 * render an explicit "not applicable for the active memory system" state.
 *
 * `config` is injectable so handlers that already resolve a (possibly
 * test-supplied) config gate against the same one; it defaults to the live
 * `loadConfig()`.
 */
export function requireActiveMemoryProvider(
  provider: MemoryProviderId,
  config: AssistantConfig = loadConfig(),
): void {
  const active = resolveMemoryProviderId(config);
  if (active !== provider) {
    throw new RouteError(
      `This endpoint applies to the "${provider}" memory system, but the active provider is "${active}".`,
      MEMORY_PROVIDER_NOT_ACTIVE_CODE,
      404,
    );
  }
}
