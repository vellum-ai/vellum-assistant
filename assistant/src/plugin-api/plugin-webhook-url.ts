/**
 * Public URL resolution for a plugin's own ingress route.
 *
 * A plugin that receives third-party webhooks has to tell the vendor where to
 * deliver, which means knowing its own public URL. Composing one from
 * `ingress.publicBaseUrl` is the obvious move and it is wrong in the case that
 * matters most: on a platform-connected assistant that value holds the Velay
 * tunnel URL, so a plugin that reads it registers a vendor webhook against a
 * tunnel instead of the managed platform callback route. The registration
 * looks fine and every delivery goes to the wrong place.
 *
 * The resolution order that is actually correct already exists — it is what
 * `webhooks register` and the Telegram webhook manager both use — so this
 * exposes that rather than restating it:
 *
 *   1. Platform pods always use a managed callback route.
 *   2. Otherwise a configured public ingress wins.
 *   3. A platform-connected assistant with no ingress falls back to a managed
 *      callback route.
 *
 * Plugins should call this instead of reading config. The order has changed
 * before and will change again; a plugin that derived its own copy would keep
 * whichever version it was written against.
 */

import { getConfig } from "../config/loader.js";
import { resolveCallbackUrl } from "../inbound/platform-callback-registration.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";

/**
 * The namespace the gateway serves plugin ingress under. Fixed here rather
 * than passed in: a plugin naming its own prefix could claim another's route.
 */
const PLUGIN_WEBHOOK_PREFIX = "webhooks/plugins";

/** Plugin and route names that are safe as URL path segments. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

export interface PluginWebhookUrlOptions {
  /**
   * The calling plugin's manifest name.
   *
   * Passed rather than inferred: plugin execution context is set for tools,
   * and a plugin resolves its ingress URL from its `init` hook or a route
   * handler, where it is not. Composing the path here from a name the caller
   * supplies is no weaker than what those paths already do, and it keeps the
   * prefix and the encoding out of every plugin.
   */
  plugin: string;
  /**
   * Route path within the plugin's namespace — `"events-photon"`, not a
   * leading slash and not the full path.
   */
  path: string;
  /** Human-readable label for the platform's admin display, when registering. */
  sourceIdentifier?: string;
}

/**
 * Resolve the public URL a third party should deliver to for `path`.
 *
 * Registering with the platform is a side effect on the managed branches:
 * a callback route is created if one does not exist. That is the same
 * behaviour `assistant webhooks register` has, and it is idempotent.
 *
 * @throws when no ingress is configured and the assistant is not connected to
 *   the platform — there is no URL that would work, and returning a plausible
 *   one would produce a registration that silently receives nothing.
 */
export async function resolvePluginWebhookUrl(
  options: PluginWebhookUrlOptions,
): Promise<string> {
  const { plugin, path, sourceIdentifier } = options;

  if (!SAFE_SEGMENT.test(plugin)) {
    throw new Error(`Invalid plugin name for a webhook URL: "${plugin}"`);
  }
  const route = path.replace(/^\/+/, "");
  if (
    route.length === 0 ||
    route.split("/").some((s) => !SAFE_SEGMENT.test(s))
  ) {
    throw new Error(`Invalid plugin webhook path: "${path}"`);
  }

  const callbackPath = `${PLUGIN_WEBHOOK_PREFIX}/${plugin}/${route}`;

  return resolveCallbackUrl(
    () => `${getPublicBaseUrl(getConfig())}/${callbackPath}`,
    callbackPath,
    // Distinct per route, not per plugin: a plugin may declare several, and a
    // shared type would have each registration overwrite the last.
    `plugin_${plugin}_${route.replace(/[^a-z0-9]+/gi, "_")}`,
    undefined,
    sourceIdentifier,
  );
}
