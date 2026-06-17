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

import type { ModelIntent } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { getDisableRemoteModelProfiles } from "./env-registry.js";
import { LLMProvider } from "./schemas/llm.js";
import {
  AUTO_PROFILE_KEY,
  MANAGED_PROFILE_NAMES,
  type ManagedProfileTemplate,
} from "./seed-inference-profiles.js";

const log = getLogger("managed-profiles-remote");

/** Default timeout for the single GET against the platform. */
const DEFAULT_TIMEOUT_MS = 3000;

/** Only this response schema version is understood by this build. */
const SUPPORTED_SCHEMA_VERSION = 1;

// `ModelIntent` is a TS-only union (see providers/types.ts), so we redeclare it
// as a zod enum here for runtime validation. The compile-time guard below fails
// to compile if the two ever drift.
const MODEL_INTENT_VALUES = [
  "balanced",
  "latency-optimized",
  "quality-optimized",
  "vision-optimized",
] as const;
const ModelIntentEnum = z.enum(MODEL_INTENT_VALUES);
// Compile-time guard: the literal tuple must exactly match `ModelIntent`. If a
// new intent is added to the union (or one removed), this assignment errors.
const _modelIntentCheck: readonly ModelIntent[] = MODEL_INTENT_VALUES;
void _modelIntentCheck;

// `ManagedProfileTemplate["effort"]` is the optional effort union from
// `ProfileEntry` (EffortEnum). Validate it structurally on the wire (any
// non-empty string) and re-validate against the real effort values on map.
const EFFORT_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const EffortEnum = z.enum(EFFORT_VALUES);
type Effort = NonNullable<ManagedProfileTemplate["effort"]>;
// Compile-time guard: keep the local effort tuple in sync with the template's
// effort type.
const _effortCheck: readonly Effort[] = EFFORT_VALUES;
void _effortCheck;

// `ManagedProfileTemplate["source"]` is the `ProfileSource` union from
// `ProfileEntry`. The wire carries it as a string ("managed" expected); we
// re-validate against the real source values on map.
const SOURCE_VALUES = ["managed", "user"] as const;
const SourceEnum = z.enum(SOURCE_VALUES);
type Source = NonNullable<ManagedProfileTemplate["source"]>;
const _sourceCheck: readonly Source[] = SOURCE_VALUES;
void _sourceCheck;

const RemoteProfileSchema = z.object({
  key: z.string().min(1),
  intent: ModelIntentEnum,
  provider: LLMProvider,
  connection_name: z.string().min(1),
  source: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  max_tokens: z.number().int().positive(),
  effort: z.string().min(1),
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
 * shape (snake_case → camelCase). The `effort` field is re-validated against
 * the real effort enum so the output is a typed effort value.
 */
export function toManagedProfileTemplate(
  remote: RemoteProfile,
): ManagedProfileTemplate {
  return {
    intent: remote.intent,
    provider: remote.provider,
    connectionName: remote.connection_name,
    source: SourceEnum.parse(remote.source),
    label: remote.label,
    description: remote.description,
    maxTokens: remote.max_tokens,
    effort: EffortEnum.parse(remote.effort),
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
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
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
      templates[remote.key] = toManagedProfileTemplate(remote);
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
