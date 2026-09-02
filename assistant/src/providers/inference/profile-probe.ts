/**
 * Live save-time probe for a user-authored inference profile: one minimal
 * request dispatched through the profile's own resolved model and connection,
 * so a wrong model name, a rejected key, or an impossible token budget
 * surfaces when the profile is saved instead of on the first chat message.
 *
 * The verdict is advisory and classified by which object the user should fix
 * (this profile vs its provider connection), using the semantic
 * `ProviderErrorReason` the provider adapters stamp at their throw sites.
 * Managed and routing-identity profiles are never probed: their pins are
 * hand-validated, and a probe there would spend managed credits on every
 * save.
 */

import type { ResolutionFallbackReason } from "../../config/llm-resolver.js";
import {
  resolveCallSiteConfig,
  selectWinningProfile,
} from "../../config/llm-resolver.js";
import { getConfigReadOnly } from "../../config/loader.js";
import { getDb } from "../../persistence/db-connection.js";
import { ProviderError, type ProviderErrorReason } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { dispatchProviderResolvable } from "../connection-resolution.js";
import {
  createTimeout,
  getConfiguredProvider,
  userMessage,
} from "../provider-send-message.js";
import { ROUTING_IDENTITY_PROVIDERS } from "./auth.js";
import { getConnection, MANAGED_CONNECTION_NAMES } from "./connections.js";
import { PROBE_TIMEOUT_MS } from "./endpoint-probe.js";

const log = getLogger("inference-profile-probe");

/** Which object the user should fix when the probe fails. */
export type ProfileCheckBlame =
  | "profile"
  | "provider"
  | "transient"
  | "unknown";

export interface ProfileCheck {
  ok: boolean;
  blame?: ProfileCheckBlame;
  /** Semantic reason (ProviderErrorReason, or "resolution"/"not_configured"). */
  reason?: string;
  /** Upstream or resolver error text, verbatim. */
  detail?: string;
  /** The connection to inspect when `blame` is "provider". */
  connection?: string;
  /** English summary for non-localized surfaces (the CLI). */
  message?: string;
}

const PROVIDER_BLAME_REASONS: ReadonlySet<ProviderErrorReason> = new Set([
  "invalid_credentials",
  "insufficient_credits",
  "daily_limit_reached",
  "network_error",
  "server_error",
]);

const TRANSIENT_BLAME_REASONS: ReadonlySet<ProviderErrorReason> = new Set([
  "rate_limited",
  "overloaded",
]);

/**
 * Map a failed probe dispatch onto the object the user should fix. Reasons
 * the adapters stamp about the request itself (model unknown or restricted,
 * parameter and token-budget rejections) blame the profile; credential,
 * billing, and reachability reasons blame the provider connection.
 */
export function classifyProbeFailure(err: unknown): {
  blame: ProfileCheckBlame;
  reason?: string;
  detail: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ProviderError) || err.reason === undefined) {
    return { blame: "unknown", detail };
  }
  if (PROVIDER_BLAME_REASONS.has(err.reason)) {
    return { blame: "provider", reason: err.reason, detail };
  }
  if (TRANSIENT_BLAME_REASONS.has(err.reason)) {
    return { blame: "transient", reason: err.reason, detail };
  }
  if (err.reason === "unknown") {
    return { blame: "unknown", reason: err.reason, detail };
  }
  return { blame: "profile", reason: err.reason, detail };
}

function checkMessage(check: {
  blame: ProfileCheckBlame;
  detail: string;
  connection?: string;
}): string {
  switch (check.blame) {
    case "profile":
      return `A test request through this profile failed: ${check.detail} Check the profile's model and parameters.`;
    case "provider":
      return (
        `A test request through this profile failed: ${check.detail} ` +
        (check.connection
          ? `Check the provider connection "${check.connection}".`
          : `Check the profile's provider connection.`)
      );
    case "transient":
      return `A test request through this profile could not complete: ${check.detail} This may be temporary.`;
    default:
      return `A test request through this profile failed: ${check.detail}`;
  }
}

/**
 * Probe a saved profile with one minimal request. Returns `null` when there
 * is no verdict to give: the profile does not exist or is disabled, it rides
 * a managed or routing-identity route (probing would bill managed credits),
 * or the probe timed out without an answer.
 */
export async function probeInferenceProfile(
  name: string,
): Promise<ProfileCheck | null> {
  const { llm } = getConfigReadOnly();
  const entry = llm.profiles?.[name] as Record<string, unknown> | undefined;
  if (!entry || entry.status === "disabled" || entry.source === "managed") {
    return null;
  }

  const selectionSeed = crypto.randomUUID();

  // If the resolver would fall back past this profile, the probe must not run:
  // it would silently exercise (and bill) a different profile. The fallback
  // reason is itself the verdict.
  let fallbackReason: ResolutionFallbackReason | undefined;
  const winner = selectWinningProfile("inference", llm, {
    overrideProfile: name,
    selectionSeed,
    // The same resolvability predicate dispatch applies: without it this
    // pre-check can report the requested profile as winner while the actual
    // dispatch below falls back to (and bills) a different profile.
    isResolvableProvider: dispatchProviderResolvable,
    onResolutionFallback: (info) => {
      if (info.requested === name) {
        fallbackReason = info.reason;
      }
    },
  });
  if (winner.profileName !== name) {
    const detail = `The profile is ${fallbackReason ?? "unusable"} and requests would silently run on ${winner.profileName ?? "the default"} instead.`;
    return {
      ok: false,
      blame: "profile",
      reason: "resolution",
      detail,
      message: checkMessage({ blame: "profile", detail }),
    };
  }

  // Billing guards run on the fully resolved call-site config — the same
  // composition dispatch consumes (mix arm expanded, call-site overrides
  // applied) — so neither a mix nor an `llm.callSites.inference` provider
  // tweak can route the probe onto a managed or platform-billed path the
  // stored entry hid. Same seed as the dispatch below, so the judged arm is
  // the dispatched arm.
  const resolved = resolveCallSiteConfig("inference", llm, {
    overrideProfile: name,
    selectionSeed,
  });
  const provider = resolved.provider ?? "";
  if (ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    return null;
  }
  const connection = resolved.provider_connection ?? (provider || undefined);
  // Canonical managed names always dispatch platform-billed: routing ignores
  // a user-owned row that merely claims such a name
  // (tryResolveProviderForConnectionName), so the name gates the probe
  // regardless of the row's stored auth.
  if (connection && MANAGED_CONNECTION_NAMES.has(connection)) {
    return null;
  }
  // A legacy profile can declare a concrete provider while staying bound to
  // a platform-billed connection row; the row's auth is the billing fact, so
  // it gates the probe too.
  const boundRow = connection ? getConnection(getDb(), connection) : null;
  if (boundRow?.auth.type === "platform") {
    return null;
  }

  const timeout = createTimeout(PROBE_TIMEOUT_MS);
  try {
    const providerInstance = await getConfiguredProvider("inference", {
      overrideProfile: name,
      selectionSeed,
    });
    if (!providerInstance) {
      const detail = "No dispatchable provider is configured for this profile.";
      return {
        ok: false,
        blame: "provider",
        reason: "not_configured",
        detail,
        connection,
        message: checkMessage({ blame: "provider", detail, connection }),
      };
    }
    // Final billing gate on the route dispatch ACTUALLY resolved: a profile
    // without a binding gets its row auto-selected inside
    // getConfiguredProvider, so only the stamped attribution names the row
    // this request would sign with.
    const route = providerInstance.routeAttribution;
    if (route?.isManagedRoute) {
      return null;
    }
    const routedRow = route?.connectionName
      ? getConnection(getDb(), route.connectionName)
      : null;
    if (routedRow?.auth.type === "platform") {
      return null;
    }
    await providerInstance.sendMessage(
      [userMessage("Reply with only the word OK.")],
      {
        signal: timeout.signal,
        config: {
          callSite: "inference",
          overrideProfile: name,
          selectionSeed,
        },
      },
    );
    return { ok: true };
  } catch (err) {
    if (timeout.signal.aborted) {
      // No verdict: a slow model and a dead endpoint look identical here,
      // and the connection-level probe already covers unreachable hosts.
      log.info({ profile: name }, "Profile probe timed out without a verdict");
      return null;
    }
    const classified = classifyProbeFailure(err);
    return {
      ok: false,
      ...classified,
      ...(classified.blame === "provider" ? { connection } : {}),
      message: checkMessage({
        ...classified,
        ...(classified.blame === "provider" ? { connection } : {}),
      }),
    };
  } finally {
    timeout.cleanup();
  }
}
