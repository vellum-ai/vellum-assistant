/**
 * Fetch + validate + map the platform's managed model-profiles endpoint.
 *
 * The platform serves the daemon's managed default model profiles from
 * `GET /v1/assistants/{assistant_id}/model-profiles/`. This module performs a
 * single bounded GET, validates the response with zod, and maps it into the
 * internal `ManagedProfileTemplate` shape so the seeder can use platform-pushed
 * profile content instead of the hardcoded built-ins.
 *
 * Design contract: this module NEVER throws to its caller and NEVER blocks
 * startup. Every failure path — kill-switch set, platform disabled/unreachable,
 * slow (>timeout), non-ok status, malformed body, unrecognized schema version,
 * or an unknown profile key — returns `null`, and the caller falls back to the
 * built-in templates wholesale.
 */

import { z } from "zod";

import { MANAGED_CONNECTION_NAMES } from "../providers/inference/connections.js";
import { isModelIntent } from "../providers/model-intents.js";
import { getLogger } from "../util/logger.js";
import { getDisableRemoteModelProfiles } from "./env-registry.js";
import { EffortEnum, LLMProvider, ProfileSource } from "./schemas/llm.js";
import {
  AUTO_PROFILE_KEY,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
  type ManagedProfileTemplate,
} from "./seed-inference-profiles.js";

const log = getLogger("managed-profiles-remote");

/** Default timeout for the single GET against the platform. */
const DEFAULT_TIMEOUT_MS = 3000;

/** Only this response schema version is understood by this build. */
const SUPPORTED_SCHEMA_VERSION = 1;

const RemoteProfileSchema = z.object({
  key: z.string().min(1),
  intent: z.string().refine(isModelIntent, { message: "unknown model intent" }),
  provider: LLMProvider,
  connection_name: z.string().min(1),
  source: ProfileSource,
  label: z.string().min(1),
  description: z.string(),
  max_tokens: z.number().int().positive(),
  effort: EffortEnum,
  thinking: z.object({ enabled: z.boolean(), stream_thinking: z.boolean() }),
  context_window: z.object({ max_input_tokens: z.number().int().positive() }),
});
type RemoteProfile = z.infer<typeof RemoteProfileSchema>;

const RemoteManagedProfilesResponseSchema = z.object({
  schema_version: z.number().int(),
  profiles: z.array(RemoteProfileSchema),
});

/**
 * Map a validated remote profile into the internal `ManagedProfileTemplate`
 * shape (snake_case → camelCase). `RemoteProfileSchema` already validates every
 * field, so this is a pure field rename with no further validation.
 */
export function toManagedProfileTemplate(
  remote: RemoteProfile,
): ManagedProfileTemplate {
  return {
    intent: remote.intent,
    provider: remote.provider,
    connectionName: remote.connection_name,
    source: remote.source,
    label: remote.label,
    description: remote.description,
    maxTokens: remote.max_tokens,
    effort: remote.effort,
    thinking: {
      enabled: remote.thinking.enabled,
      streamThinking: remote.thinking.stream_thinking,
    },
    contextWindow: { maxInputTokens: remote.context_window.max_input_tokens },
  };
}

/**
 * Built-in managed profile names that a remote payload is allowed to carry.
 * `AUTO_PROFILE_KEY` is a metadata-only profile with no model config — it is
 * not served by the endpoint, so it's excluded from the known-keys gate.
 */
const ALLOWED_REMOTE_KEYS = new Set(
  [...MANAGED_PROFILE_NAMES].filter((name) => name !== AUTO_PROFILE_KEY),
);

/**
 * Canonical connection-name → provider mapping, derived from the built-in
 * `MANAGED_PROFILE_TEMPLATES` so there is a single source of truth. A remote
 * payload's `(provider, connection_name)` pairing must agree with the built-in
 * pairing for that connection — otherwise the seeded profile's provider and
 * `provider_connection` would disagree and the provider resolver would treat it
 * as a hard config error or auto-reroute, breaking the managed profile instead
 * of falling back wholesale.
 */
const CANONICAL_CONNECTION_PROVIDER = new Map<string, string>(
  Object.values(MANAGED_PROFILE_TEMPLATES).map((t) => [
    t.connectionName,
    t.provider,
  ]),
);

/**
 * Sentinel returned by the timeout arm of the bounded race. Distinct from
 * `null` so we can tell "timed out" from a legitimate `null` failure result.
 */
const TIMED_OUT = Symbol("managed-profiles-remote-timeout");

/**
 * Fetch the managed model-profile templates from the platform.
 *
 * Performs at most one bounded GET. Returns a `key → ManagedProfileTemplate`
 * map on success, or `null` on ANY failure (the caller falls back to built-in
 * templates). Never throws.
 */
export async function fetchManagedProfileTemplates(opts?: {
  timeoutMs?: number;
}): Promise<Record<string, ManagedProfileTemplate> | null> {
  if (getDisableRemoteModelProfiles()) {
    log.debug(
      "Remote model profiles disabled by kill-switch — using built-ins",
    );
    return null;
  }

  const budgetMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Bound the ENTIRE operation — client creation included — by the budget.
  // `VellumPlatformClient.create()` performs unbounded secure-key reads (CES
  // can take ~45s) and honors no abort signal, so we race the whole async path
  // against a single timer. The GET also gets its own `AbortSignal.timeout` so
  // the underlying socket is actually cancelled when the timer wins.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
  });

  // Attach a no-op catch so that if the work promise rejects AFTER the timeout
  // has already won the race, the late rejection doesn't surface as an
  // unhandled rejection and crash the process.
  const work = fetchManagedProfileTemplatesUnbounded(budgetMs);
  work.catch(() => {});

  try {
    const result = await Promise.race([work, timeout]);
    if (result === TIMED_OUT) {
      log.warn(
        { budgetMs },
        "Remote model-profiles fetch exceeded timeout budget — using built-ins",
      );
      return null;
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The unbounded fetch + validate + map pipeline. Never throws (every failure
 * path returns `null`); the caller in `fetchManagedProfileTemplates` is
 * responsible for bounding total wall-clock time via `Promise.race`.
 */
async function fetchManagedProfileTemplatesUnbounded(
  budgetMs: number,
): Promise<Record<string, ManagedProfileTemplate> | null> {
  try {
    const { VellumPlatformClient } = await import("../platform/client.js");
    const client = await VellumPlatformClient.create();
    if (!client?.platformAssistantId) {
      log.debug(
        "Platform client unavailable or missing assistant id — using built-ins",
      );
      return null;
    }

    const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/model-profiles/`;
    const response = await client.fetch(path, {
      signal: AbortSignal.timeout(budgetMs),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status },
        "Remote model-profiles fetch returned non-ok status — using built-ins",
      );
      return null;
    }

    const parsed = RemoteManagedProfilesResponseSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success) {
      log.warn(
        { error: parsed.error.message },
        "Remote model-profiles payload failed validation — using built-ins",
      );
      return null;
    }

    if (parsed.data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      log.warn(
        { schemaVersion: parsed.data.schema_version },
        "Remote model-profiles schema version unsupported — using built-ins",
      );
      return null;
    }

    const templates: Record<string, ManagedProfileTemplate> = {};
    for (const remote of parsed.data.profiles) {
      if (!ALLOWED_REMOTE_KEYS.has(remote.key)) {
        log.warn(
          { key: remote.key },
          "Remote model-profiles payload introduced an unknown managed key — using built-ins",
        );
        return null;
      }
      if (!MANAGED_CONNECTION_NAMES.has(remote.connection_name)) {
        log.warn(
          { key: remote.key, connectionName: remote.connection_name },
          "Remote model-profiles payload referenced a non-canonical managed connection — using built-ins",
        );
        return null;
      }
      if (
        CANONICAL_CONNECTION_PROVIDER.get(remote.connection_name) !==
        remote.provider
      ) {
        log.warn(
          {
            key: remote.key,
            provider: remote.provider,
            connectionName: remote.connection_name,
          },
          "Remote model-profiles payload paired a managed connection with the wrong provider — using built-ins",
        );
        return null;
      }
      templates[remote.key] = toManagedProfileTemplate(remote);
    }

    // Wholesale-fallback gate: the payload must carry the FULL expected managed
    // key set. An empty or partial map would leave omitted profiles un-seeded
    // while profileOrder/activeProfile still reference the built-in names, so
    // anything short of the complete set falls back to built-ins entirely.
    const missingKeys = [...ALLOWED_REMOTE_KEYS].filter(
      (key) => !(key in templates),
    );
    if (missingKeys.length > 0) {
      log.warn(
        { missingKeys },
        "Remote model-profiles payload is missing expected managed keys — using built-ins",
      );
      return null;
    }

    log.info(
      { count: Object.keys(templates).length },
      "Loaded managed model profiles from platform",
    );
    return templates;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Remote model-profiles fetch failed — using built-ins",
    );
    return null;
  }
}
