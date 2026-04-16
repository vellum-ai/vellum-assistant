/**
 * Registry for skill shutdown hooks.
 *
 * Skills register async shutdown callbacks at initialization time. The daemon
 * calls {@link runShutdownHooks} during graceful shutdown so skill-owned
 * resources (containers, sockets, etc.) are torn down before the process exits.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("shutdown-registry");

type ShutdownHook = (reason: string) => Promise<void>;

const hooks = new Map<string, ShutdownHook>();

/**
 * Register a named shutdown hook. Called by skills at initialization time.
 * If a hook with the same name already exists it is silently replaced (supports
 * hot-reload).
 */
export function registerShutdownHook(name: string, hook: ShutdownHook): void {
  hooks.set(name, hook);
  log.info({ name }, "Shutdown hook registered");
}

/**
 * Run all registered shutdown hooks. Each hook receives a human-readable
 * `reason` string (e.g. "daemon-shutdown"). Failures are logged but do not
 * prevent other hooks from running.
 */
export async function runShutdownHooks(reason: string): Promise<void> {
  for (const [name, hook] of hooks) {
    try {
      await hook(reason);
    } catch (err) {
      log.warn({ err, name }, `Shutdown hook "${name}" failed (non-fatal)`);
    }
  }
}
