/**
 * Fetch managed model profiles from the platform.
 *
 * Hits `GET /v1/assistants/{id}/model-profiles/` and validates the response
 * against the Django serializer contract. The discriminated result lets
 * callers distinguish a missing platform connection ("no-connection" — safe to
 * prune local profiles) from a transient failure ("error" — preserve whatever
 * is on disk so a blip never wipes profiles).
 */

import { z } from "zod";

import { EffortEnum, LLMProvider } from "../config/schemas/llm.js";
import { isModelIntent } from "../providers/model-intents.js";
import { getLogger } from "../util/logger.js";
import {
  classifyMissingPlatformCredential,
  VellumPlatformClient,
} from "./client.js";

const log = getLogger("managed-profiles");

// Validate the platform record against the assistant's own contract enums so an
// out-of-contract value (unknown intent/provider/effort) rejects the whole
// response (-> "error", preserve on-disk) rather than persisting a profile
// whose model would silently fall back to a default. `intent` is refined
// against `isModelIntent` (the `ModelIntent` set has no standalone zod enum);
// `provider`/`effort` reuse the config schema's enums so the lists can't drift.
const PlatformManagedProfileSchema = z.object({
  key: z.string(),
  intent: z.string().refine(isModelIntent, {
    message: "intent is not a known ModelIntent",
  }),
  provider: LLMProvider,
  connection_name: z.string(),
  source: z.string(),
  label: z.string(),
  description: z.string(),
  max_tokens: z.number(),
  effort: EffortEnum,
  thinking: z.object({ enabled: z.boolean(), stream_thinking: z.boolean() }),
  context_window: z.object({ max_input_tokens: z.number() }),
});

const PlatformManagedProfilesResponseSchema = z.object({
  schema_version: z.number(),
  profiles: z.array(PlatformManagedProfileSchema),
});

export type PlatformManagedProfile = z.infer<
  typeof PlatformManagedProfileSchema
>;

/**
 * Result of {@link fetchManagedProfiles}.
 *
 * - `no-connection`: the install is GENUINELY not platform-connected — platform
 *   credentials are confirmed absent (the credential read succeeded and returned
 *   nothing). The 4 managed profiles are truly unusable here, so callers may
 *   safely prune them.
 * - `ok`: profiles fetched and validated.
 * - `error`: any HTTP/parse/timeout/schema-version failure, OR a transient
 *   inability to read platform credentials/context (e.g. the credential backend
 *   is unreachable), OR a still-credentialed install with platform features
 *   disabled (VELLUM_DISABLE_PLATFORM). Callers must preserve on-disk profiles
 *   rather than prune — a temporary toggle or blip must never wipe user
 *   label/status overrides + pins.
 */
export type FetchManagedProfilesResult =
  | { status: "no-connection" }
  | { status: "ok"; profiles: PlatformManagedProfile[] }
  | { status: "error" };

/**
 * Fetch the assistant's managed model profiles from the platform.
 *
 * Best-effort: never throws to the caller. Uses a bounded timeout so a hung
 * platform never stalls the caller.
 */
export async function fetchManagedProfiles(): Promise<FetchManagedProfilesResult> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    return classifyMissingClient();
  }

  const assistantId = client.platformAssistantId;
  if (!assistantId) {
    // We have a connection but cannot address the assistant — do not prune.
    log.warn("No platform assistant ID configured — cannot fetch profiles");
    return { status: "error" };
  }

  try {
    const resp = await client.fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/model-profiles/`,
      { signal: AbortSignal.timeout(5_000) },
    );

    if (!resp.ok) {
      log.warn(
        { status: resp.status, assistantId },
        "Failed to fetch managed profiles from platform",
      );
      return { status: "error" };
    }

    const json = await resp.json();
    const parsed = PlatformManagedProfilesResponseSchema.safeParse(json);
    if (!parsed.success) {
      log.warn(
        { err: parsed.error, assistantId },
        "Managed profiles response failed validation",
      );
      return { status: "error" };
    }

    if (parsed.data.schema_version !== 1) {
      // An unknown schema version must never overwrite or prune on-disk profiles.
      log.warn(
        { schemaVersion: parsed.data.schema_version, assistantId },
        "Unsupported managed profiles schema version",
      );
      return { status: "error" };
    }

    return { status: "ok", profiles: parsed.data.profiles };
  } catch (err) {
    log.warn({ err, assistantId }, "Error fetching managed profiles");
    return { status: "error" };
  }
}

/**
 * Classify why `VellumPlatformClient.create()` returned null.
 *
 * `create()` collapses three distinct conditions into a single `null`:
 *   1. Platform credentials are genuinely absent (read succeeded, empty) — a
 *      true off-platform install.
 *   2. Platform features are disabled (VELLUM_DISABLE_PLATFORM) on an install
 *      whose credentials are still present.
 *   3. Platform credentials could not be read (backend transiently unreachable).
 *
 * We classify purely on credential presence, NOT on the feature flag: only (1)
 * means the 4 managed profiles are truly unusable, so only (1) yields
 * `no-connection` (prune). (2) and (3) both yield `error` (preserve) — a
 * disabled flag is a temporary "pause outbound platform calls" toggle, and an
 * unreadable store is a transient blip; pruning in either case would delete the
 * user's label/status overrides + call-site pins, which is exactly the
 * data-loss the `error`/`no-connection` split exists to prevent.
 *
 * Credential presence is delegated to {@link classifyMissingPlatformCredential}
 * in `client.ts` (the module authorized to read secure keys), which reads the
 * credential store directly and does NOT consult the feature flag — so it still
 * reports "present" even when platform features are disabled. Only an explicit
 * "credentials absent" yields `no-connection`; everything else is treated as
 * transient (`error`, preserve). When in doubt we prefer preservation.
 */
async function classifyMissingClient(): Promise<FetchManagedProfilesResult> {
  const avail = await classifyMissingPlatformCredential();
  return avail === "absent" ? { status: "no-connection" } : { status: "error" };
}
