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

import { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";

const log = getLogger("managed-profiles");

const PlatformManagedProfileSchema = z.object({
  key: z.string(),
  intent: z.string(),
  provider: z.string(),
  connection_name: z.string(),
  source: z.string(),
  label: z.string(),
  description: z.string(),
  max_tokens: z.number(),
  effort: z.string(),
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
 * - `no-connection`: no platform client (not platform-hosted / missing creds).
 *   Callers may safely prune local managed profiles.
 * - `ok`: profiles fetched and validated.
 * - `error`: any HTTP/parse/timeout/schema-version failure. Callers should
 *   preserve on-disk profiles rather than prune.
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
    return { status: "no-connection" };
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
