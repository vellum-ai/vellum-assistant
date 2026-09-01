/**
 * The one place that answers "does this assistant have a managed inbox?".
 *
 * Managed email registration lives on the Vellum platform: the
 * `/v1/assistants/:id/email-addresses/` API is the only writer and the only
 * source of truth. Nothing about a registration lands in workspace config, so
 * any reader that wants the inbox address has to ask the platform. The three
 * consumers (the email readiness probe, the email invite adapter, and the
 * channel-availability route) all resolve through here so they cannot drift
 * onto different answers.
 *
 * `unavailable` is distinct from `none` for the same reason the readiness
 * service separates "failed" from "indeterminate": an unreachable platform is
 * not evidence that no inbox exists, and reporting it as one turns every
 * platform blip into a "set up email" prompt.
 */

import { z } from "zod";

import { VellumPlatformClient } from "../platform/client.js";

export type RegisteredInboxState =
  /** The platform holds a registered inbox address for this assistant. */
  | { status: "registered"; address: string }
  /** The platform answered: no inbox is registered. */
  | { status: "none" }
  /** No platform credentials, so no managed inbox can exist. */
  | { status: "no_platform" }
  /** The platform could not be asked; nothing is known either way. */
  | { status: "unavailable"; detail: string };

/**
 * Validated rather than cast: the response crosses a runtime boundary, and a
 * shape drift should read as `unavailable` (nothing established), not as a
 * confidently wrong answer. Unknown keys are ignored, since the platform adds
 * fields over time.
 */
const EmailAddressListSchema = z.object({
  count: z.number().optional(),
  results: z.array(z.object({ address: z.string() })).optional(),
});

/**
 * Matches the readiness service's remote-check TTL: the cache exists so the
 * invite-adapter enrichment on the readiness poll (every 15s per client) does
 * not turn into a platform request per poll, and registration changes made
 * through the daemon invalidate it explicitly.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { state: RegisteredInboxState; fetchedAt: number } | null = null;

/** Drop the cached answer; call after registering or releasing an inbox. */
export function invalidateRegisteredInboxCache(): void {
  cache = null;
}

/**
 * Resolve the managed inbox state, serving a cached answer within
 * {@link CACHE_TTL_MS} unless `fresh` demands a live read. `unavailable` is
 * never cached: a platform blip should heal on the next call, not pin the
 * unknown state for the TTL.
 */
export async function resolveRegisteredInbox(
  options: { fresh?: boolean } = {},
): Promise<RegisteredInboxState> {
  if (!options.fresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.state;
  }

  const state = await fetchRegisteredInbox();
  if (state.status === "unavailable") {
    return state;
  }
  cache = { state, fetchedAt: Date.now() };
  return state;
}

async function fetchRegisteredInbox(): Promise<RegisteredInboxState> {
  const client = await VellumPlatformClient.create();
  if (!client?.platformAssistantId) {
    return { status: "no_platform" };
  }

  let response: Response;
  try {
    response = await client.fetch(
      `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "unavailable", detail };
  }

  if (!response.ok) {
    return { status: "unavailable", detail: `HTTP ${response.status}` };
  }

  const parsed = EmailAddressListSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return { status: "unavailable", detail: "unexpected response shape" };
  }

  const address = parsed.data.results?.[0]?.address;
  if (typeof address === "string" && address.length > 0) {
    return { status: "registered", address };
  }
  return { status: "none" };
}
