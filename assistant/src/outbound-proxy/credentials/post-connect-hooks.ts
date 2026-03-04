/**
 * Post-connect hooks for OAuth2 services.
 *
 * This module decouples provider-specific post-connection side effects
 * (e.g. sending a welcome DM after Slack OAuth) from the generic vault
 * OAuth2 flow. Each hook is keyed by canonical service name and receives
 * the raw token response so it can perform provider-specific actions.
 *
 * Hooks are registered via the `configurePostConnectHooks` setter in deps.ts
 * by the host process (assistant) at startup.
 */

import {
  getLogger,
  getPostConnectHooks,
  type PostConnectHookContext,
} from "./deps.js";

const log = getLogger("post-connect-hooks");

// Re-export the context type for consumers
export type { PostConnectHookContext } from "./deps.js";

/**
 * Run the post-connect hook for a service, if one is registered.
 * Failures are logged but never propagated -- they must not break the OAuth flow.
 */
export async function runPostConnectHook(
  ctx: PostConnectHookContext,
): Promise<void> {
  const hooks = getPostConnectHooks();
  const hook = hooks[ctx.service];
  if (!hook) return;

  try {
    await hook(ctx);
  } catch (err) {
    log.warn(
      { err, service: ctx.service },
      "Post-connect hook failed (non-fatal)",
    );
  }
}
