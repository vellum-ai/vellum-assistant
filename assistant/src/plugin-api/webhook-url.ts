/**
 * Public URL resolution for a plugin's own ingress route.
 *
 * A plugin that receives third-party webhooks has to tell the vendor where to
 * deliver. Which URL is correct depends on how the assistant is reachable:
 * a platform pod and a platform-connected assistant are served through a
 * managed callback route, while a self-hosted deployment is served through its
 * configured public ingress. `ingress.publicBaseUrl` alone does not decide it,
 * because on a platform-connected assistant that value holds the Velay tunnel
 * address, which is not where plugin routes are served.
 *
 * `resolveCallbackUrl` owns that decision for every caller in the codebase
 * (`webhooks register`, the Telegram webhook manager). This exposes it to
 * plugins so there is one implementation rather than one per plugin.
 */

import { createHash } from "node:crypto";

import { getConfig } from "../config/loader.js";
import { resolveCallbackUrl } from "../inbound/platform-callback-registration.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";
import { getCurrentPluginName } from "../plugins/plugin-execution-context.js";

/**
 * The namespace the gateway serves plugin ingress under. Fixed here rather
 * than supplied by the caller, so a plugin cannot claim another's routes.
 */
const PLUGIN_WEBHOOK_PREFIX = "webhooks/plugins";

/** Plugin directory names usable as a URL path segment. */
const SAFE_PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Route paths the gateway serves, matching `IngressRouteSchema` in
 * `gateway/src/channels/plugin-ingress.ts`: relative, free of query, fragment
 * and whitespace, canonical under percent-decoding, and carrying no `.` or
 * `..` segment.
 *
 * The two must agree. A path this rejects but the gateway serves is a route a
 * plugin can install and then never resolve a URL for.
 */
function isServableRoutePath(value: string): boolean {
  if (value.length === 0 || value.endsWith("/")) {
    return false;
  }
  if (!/^[^/?#\s][^?#\s]*$/.test(value)) {
    return false;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded !== value) {
    return false;
  }
  return !value.split("/").some((seg) => seg === "." || seg === "..");
}

export interface WebhookUrlOptions {
  /**
   * Route path within the plugin's namespace, such as `"events-photon"`.
   * Relative, with no leading slash.
   */
  path: string;
  /**
   * Plugin whose namespace the route belongs to.
   *
   * Defaults to the plugin in context, which covers hooks and tools. Supply it
   * explicitly from a plugin route handler, where no context is established.
   */
  plugin?: string;
  /** Human-readable label for the platform's admin display. */
  sourceIdentifier?: string;
}

/**
 * Registration type for one route.
 *
 * The platform keys a callback route by type, so two routes of one plugin need
 * two types or the second registration replaces the first. The slug keeps the
 * type legible in the platform's admin display and the digest keeps it unique:
 * `events-v1` and `events_v1` share a slug and differ here.
 */
function registrationType(plugin: string, route: string): string {
  const slug = route.replace(/[^a-z0-9]+/gi, "_");
  const digest = createHash("sha256").update(route).digest("hex").slice(0, 8);
  return `plugin_${plugin}_${slug}_${digest}`;
}

/**
 * Keep a trailing slash on a resolved callback URL.
 *
 * Django in front of managed callbacks canonicalizes onto `/`. A vendor given
 * the slashless spelling is 301'd, and clients that follow a 301 on POST
 * typically retry as GET and drop the body. The gateway serves both spellings
 * of a plugin webhook, so the slashed URL is the one to hand out.
 *
 * Query-bearing URLs are left alone: this resolver passes no query
 * parameters, and appending there would cut into the query rather than the
 * path. The callback path registered with the platform stays slashless. The
 * platform strips slashes on store, and Django's path converter typically
 * does not include the final `/` in the lookup key.
 */
function withTrailingSlash(url: string): string {
  if (url.includes("?") || url.includes("#")) {
    return url;
  }
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Resolve the public URL a third party should deliver to for `path`.
 *
 * On the managed branches this registers a callback route with the platform,
 * which is idempotent and matches what `assistant webhooks register` does.
 *
 * @throws when the plugin cannot be determined, when `path` is not one the
 *   gateway would serve, or when no ingress is configured and the assistant is
 *   not connected to the platform. That last case has no URL that would work,
 *   and a plausible one would produce a vendor registration that silently
 *   receives nothing.
 */
export async function resolveWebhookUrl(
  options: WebhookUrlOptions,
): Promise<string> {
  const { path, sourceIdentifier } = options;
  const plugin = options.plugin ?? getCurrentPluginName();

  if (plugin === undefined) {
    throw new Error(
      "No plugin is in context; pass `plugin` to resolve a webhook URL.",
    );
  }
  if (!SAFE_PLUGIN_NAME.test(plugin)) {
    throw new Error(`Invalid plugin name for a webhook URL: "${plugin}"`);
  }
  if (!isServableRoutePath(path)) {
    throw new Error(`Invalid plugin webhook path: "${path}"`);
  }

  const callbackPath = `${PLUGIN_WEBHOOK_PREFIX}/${plugin}/${path}`;

  const resolved = await resolveCallbackUrl(
    () => `${getPublicBaseUrl(getConfig())}/${callbackPath}`,
    callbackPath,
    registrationType(plugin, path),
    undefined,
    sourceIdentifier,
  );
  return withTrailingSlash(resolved);
}
