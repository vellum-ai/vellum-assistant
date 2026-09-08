/**
 * The one place that answers "does this assistant have a managed inbox?".
 *
 * Managed email registration lives on the Vellum platform: the
 * `/v1/assistants/:id/email-addresses/` API is the only writer and the only
 * source of truth. Nothing about a registration lands in workspace config, so
 * any reader that wants the inbox address has to ask the platform. Every
 * consumer of the listing (the email readiness probe, the email invite
 * adapter, the channel-availability route, the email management routes, and
 * verification email delivery) reads through this module so they cannot
 * drift onto different answers.
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

/** One row of the platform's email-address listing. */
export interface RegisteredEmailAddress {
  id: string;
  address: string;
}

export type EmailAddressListResult =
  | { ok: true; addresses: RegisteredEmailAddress[] }
  /** The platform could not be asked or answered unusably. */
  | { ok: false; status?: number; detail: string };

/**
 * Validated rather than cast: the response crosses a runtime boundary, and a
 * shape drift should read as a failed listing (nothing established), not as a
 * confidently wrong answer. Unknown keys are ignored, since the platform adds
 * fields over time.
 */
const EmailAddressListSchema = z.object({
  count: z.number().optional(),
  // Required: the platform's paginated listing always carries `results`, so
  // a 200 without it is shape drift and must read as a failed listing, never
  // as "no inbox".
  results: z.array(z.object({ id: z.string(), address: z.string() })),
});

/**
 * Fetch the platform's email-address listing for the caller's own client.
 *
 * The seam every consumer of the listing shares: the readiness resolver
 * below, the email register/unregister/status/send routes, and verification
 * email delivery. Takes the caller's client rather than creating one so a
 * route that already authenticated (and already knows how to report a
 * missing platform connection) keeps its own error semantics.
 */
export async function listEmailAddresses(
  client: VellumPlatformClient,
): Promise<EmailAddressListResult> {
  let response: Response;
  try {
    response = await client.fetch(
      `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      detail: `HTTP ${response.status}`,
    };
  }

  const parsed = EmailAddressListSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return { ok: false, detail: "unexpected response shape" };
  }

  const { count, results: addresses } = parsed.data;
  if (addresses.length === 0 && (count ?? 0) > 0) {
    // A positive count with no rows is drift, not an empty listing: treating
    // it as "no inbox" would recreate the false Not connected verdict.
    return {
      ok: false,
      detail: `listing reported ${count} addresses but returned none`,
    };
  }

  return { ok: true, addresses };
}

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
  // Creation resolves the managed-proxy context and the credential store,
  // either of which can reject; a backend blip there is "could not ask",
  // not an error the caller should surface as a failed request.
  let client: VellumPlatformClient | null;
  try {
    client = await VellumPlatformClient.create();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "unavailable", detail };
  }
  if (!client?.platformAssistantId) {
    return { status: "no_platform" };
  }

  const list = await listEmailAddresses(client);
  if (!list.ok) {
    return { status: "unavailable", detail: list.detail };
  }

  const address = list.addresses[0]?.address;
  if (typeof address === "string" && address.length > 0) {
    return { status: "registered", address };
  }
  return { status: "none" };
}
