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
import { arePlatformFeaturesEnabled } from "./feature-gate.js";

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
 *   features are disabled, or platform credentials are confirmed absent (the
 *   credential read succeeded and returned nothing). The 4 managed profiles are
 *   truly unusable here, so callers may safely prune them.
 * - `ok`: profiles fetched and validated.
 * - `error`: any HTTP/parse/timeout/schema-version failure, OR a transient
 *   inability to read platform credentials/context (e.g. the credential
 *   backend is unreachable). Callers must preserve on-disk profiles rather
 *   than prune — a blip must never wipe user label/status overrides + pins.
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
 *   1. Platform features are disabled (genuinely off-platform).
 *   2. Platform credentials are genuinely absent (read succeeded, empty).
 *   3. Platform credentials could not be read (backend transiently unreachable).
 *
 * Only (1) and (2) mean the 4 managed profiles are truly unusable and should be
 * pruned (`no-connection`). (3) is a transient failure on a possibly
 * platform-connected install — pruning there would delete the user's label/
 * status overrides + call-site pins on a blip, which is exactly the data-loss
 * the `error`/`no-connection` split exists to prevent. So we map it to `error`.
 *
 * The credential-reachability check is delegated to
 * {@link classifyMissingPlatformCredential} in `client.ts` (the module
 * authorized to read secure keys). Only an explicit "credentials absent"
 * yields `no-connection`; everything else is treated as transient (`error`,
 * preserve). When in doubt we prefer preservation.
 */
async function classifyMissingClient(): Promise<FetchManagedProfilesResult> {
  // Platform explicitly disabled — the install is genuinely off-platform.
  if (!arePlatformFeaturesEnabled()) {
    return { status: "no-connection" };
  }

  const avail = await classifyMissingPlatformCredential();
  return avail === "absent" ? { status: "no-connection" } : { status: "error" };
}
