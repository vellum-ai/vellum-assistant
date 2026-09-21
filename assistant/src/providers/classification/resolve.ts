/**
 * Resolve the configured classification provider into a dispatchable client.
 *
 * Mirrors the STT resolver's shape: read `services.classification`, look the
 * provider up in the catalog, then pick the credential by mode. Every
 * failure resolves to `null` with a reason a settings surface can show; the
 * consumers (voice judges, memory pool selector) treat `null` as "family not
 * configured" and keep their default behavior.
 */

import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { normalizeCredentialRef } from "../../security/credential-key.js";
import {
  getProviderKeyAsync,
  getSecureKeyAsync,
} from "../../security/secure-keys.js";
import { JevProvider } from "../jev/client.js";
import { resolveManagedProxyContext } from "../platform-proxy/context.js";
import { RetryProvider } from "../retry.js";
import type { Provider } from "../types.js";
import { UsageTrackingProvider } from "../usage-tracking.js";
import {
  type ClassificationProviderEntry,
  getClassificationModelEntry,
  getClassificationProviderEntry,
} from "./provider-catalog.js";

export type ClassificationCredentialSource = "user-key" | "managed-proxy";

export type ClassificationUnavailableReason =
  | "unknown_provider"
  | "missing_credential"
  | "managed_unsupported"
  | "platform_unavailable";

export interface ResolvedClassificationProvider {
  provider: Provider;
  providerId: string;
  model: string;
  /** Input budget for one call, from the catalog when the model is listed. */
  maxInputTokens: number;
  source: ClassificationCredentialSource;
}

export type ClassificationAvailability =
  | {
      available: true;
      mode: "managed" | "your-own";
      providerId: string;
      model: string;
      source: ClassificationCredentialSource;
    }
  | {
      available: false;
      mode: "managed" | "your-own";
      providerId: string;
      model: string;
      reason: ClassificationUnavailableReason;
    };

/** Budget when the configured model is not in the catalog. */
const DEFAULT_CLASSIFICATION_MAX_INPUT_TOKENS = 32_000;

type ClassificationRoute =
  | {
      ok: true;
      apiKey: string;
      baseURL?: string;
      source: ClassificationCredentialSource;
    }
  | { ok: false; reason: ClassificationUnavailableReason };

async function routeFor(
  entry: ClassificationProviderEntry,
  mode: "managed" | "your-own",
  credential: string | null | undefined,
): Promise<ClassificationRoute> {
  if (mode === "your-own") {
    const apiKey = credential
      ? await getSecureKeyAsync(normalizeCredentialRef(credential))
      : await getProviderKeyAsync(entry.credentialProvider);
    return apiKey
      ? { ok: true, apiKey, source: "user-key" }
      : { ok: false, reason: "missing_credential" };
  }
  if (!entry.managedProxyPath) {
    return { ok: false, reason: "managed_unsupported" };
  }
  const ctx = await resolveManagedProxyContext();
  if (!ctx.enabled) {
    return { ok: false, reason: "platform_unavailable" };
  }
  return {
    ok: true,
    apiKey: ctx.assistantApiKey,
    baseURL: `${ctx.platformBaseUrl}${entry.managedProxyPath}`,
    source: "managed-proxy",
  };
}

interface ClassificationSelection {
  entry: ClassificationProviderEntry;
  mode: "managed" | "your-own";
  model: string;
  route: ClassificationRoute;
}

async function selectClassification(
  config: AssistantConfig,
): Promise<ClassificationSelection | { reason: "unknown_provider" }> {
  const {
    mode,
    provider: providerId,
    model,
    credential,
  } = config.services.classification;
  const entry = getClassificationProviderEntry(providerId);
  if (!entry) {
    return { reason: "unknown_provider" };
  }
  return { entry, mode, model, route: await routeFor(entry, mode, credential) };
}

export async function resolveClassificationAvailability(
  config: AssistantConfig = getConfig(),
): Promise<ClassificationAvailability> {
  const { mode, provider: providerId, model } = config.services.classification;
  const selected = await selectClassification(config);
  if (!("entry" in selected)) {
    return {
      available: false,
      mode,
      providerId,
      model,
      reason: selected.reason,
    };
  }
  return selected.route.ok
    ? {
        available: true,
        mode,
        providerId,
        model,
        source: selected.route.source,
      }
    : {
        available: false,
        mode,
        providerId,
        model,
        reason: selected.route.reason,
      };
}

/**
 * The configured classification provider, or `null` when the family cannot
 * dispatch (no key stored, platform login missing, unknown provider).
 */
export async function resolveClassificationProvider(
  config: AssistantConfig = getConfig(),
): Promise<ResolvedClassificationProvider | null> {
  const selected = await selectClassification(config);
  if (!("entry" in selected) || !selected.route.ok) {
    return null;
  }
  const { entry, model, route } = selected;
  return {
    provider: buildClassificationProvider(entry, model, route),
    providerId: entry.id,
    model,
    maxInputTokens:
      getClassificationModelEntry(entry.id, model)?.contextWindowTokens ??
      DEFAULT_CLASSIFICATION_MAX_INPUT_TOKENS,
    source: route.source,
  };
}

/**
 * The same wrapper chain the LLM registry applies: retries plus, on the
 * managed route, the `X-Vellum-*` attribution headers derived from the
 * caller's `callSite`; and usage tracking so classification calls reach the
 * local usage ledger like every other provider call.
 */
function buildClassificationProvider(
  entry: ClassificationProviderEntry,
  model: string,
  route: Extract<ClassificationRoute, { ok: true }>,
): Provider {
  const managed = route.source === "managed-proxy";
  return new UsageTrackingProvider(
    new RetryProvider(buildClient(entry, model, route), {
      forwardUsageAttributionHeaders: managed,
      credentialSource: managed ? "vellum-managed" : "byok",
    }),
  );
}

function buildClient(
  entry: ClassificationProviderEntry,
  model: string,
  route: Extract<ClassificationRoute, { ok: true }>,
): Provider {
  switch (entry.id) {
    case "typesafe":
      return new JevProvider(route.apiKey, model, {
        ...(route.baseURL ? { baseURL: route.baseURL } : {}),
      });
    default: {
      const exhaustive: never = entry.id;
      throw new Error(
        `Unhandled classification provider: ${String(exhaustive)}`,
      );
    }
  }
}
