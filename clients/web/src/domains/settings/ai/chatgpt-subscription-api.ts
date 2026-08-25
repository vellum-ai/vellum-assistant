/**
 * API layer for connecting a ChatGPT subscription.
 *
 * `resolveChatgptConnection` is shared by both sign-in paths, which finish the
 * same way once the credential is stored.
 */

import {
  inferenceChatgptsubscriptionDeviceauthByStateDelete,
  inferenceChatgptsubscriptionDeviceauthPost,
  inferenceChatgptsubscriptionDeviceauthStatusByStateGet,
  inferenceProviderconnectionsGet,
} from "@/generated/daemon/sdk.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import type { PollStatusResponse } from "@/utils/poll-until-settled";

/**
 * Credential the daemon stores the subscription's access token under, and
 * stamps the `chatgpt-subscription` connection with.
 */
export const CHATGPT_ACCESS_TOKEN_CREDENTIAL =
  "credential/chatgpt/access_token";

/**
 * The daemon serving this assistant predates the device-code routes, so the
 * redirect-and-paste sign-in is the only path it offers.
 */
export class DeviceAuthUnsupportedError extends Error {
  constructor() {
    super("This assistant does not support device-code sign-in.");
    this.name = "DeviceAuthUnsupportedError";
  }
}

export interface ChatgptDeviceAuthStart {
  /** Opaque handle for the pending flow; the status route is keyed by it. */
  state: string;
  /** What the user types into the ChatGPT page. */
  userCode: string;
  /** Where they type it. */
  verificationUrl: string;
  /** ISO timestamp after which the code no longer works. */
  expiresAt: string;
  /** Cadence OpenAI asks the client to poll at. */
  intervalSeconds: number;
}

/**
 * Mints a device code. The user authorizes it on OpenAI's own page.
 *
 * A 404 means the route itself is absent rather than the mint failing, so it
 * throws `DeviceAuthUnsupportedError` for the caller to fall back on the paste
 * flow instead of reporting a failure.
 */
export async function startChatgptDeviceAuth(
  assistantId: string,
): Promise<ChatgptDeviceAuthStart> {
  const { data, response } = await inferenceChatgptsubscriptionDeviceauthPost({
    path: { assistant_id: assistantId },
  });
  if (response?.status === 404) {
    throw new DeviceAuthUnsupportedError();
  }
  if (!data) {
    throw new Error("Could not start ChatGPT device sign-in.");
  }
  return {
    state: data.state,
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    expiresAt: data.expires_at,
    intervalSeconds: data.interval_seconds,
  };
}

/** Asks whether the minted code has been authorized yet. */
export async function pollChatgptDeviceAuthStatus(
  assistantId: string,
  state: string,
): Promise<PollStatusResponse> {
  const { data } =
    await inferenceChatgptsubscriptionDeviceauthStatusByStateGet({
      path: { assistant_id: assistantId, state },
      throwOnError: true,
    });
  return { status: data.status, error: data.error };
}

/**
 * Tells the daemon to stop polling a code the user walked away from.
 *
 * Best-effort: the caller has already left the flow, so a failure here has
 * nothing to report to. The daemon's own expiry is the backstop.
 */
export async function cancelChatgptDeviceAuth(
  assistantId: string,
  state: string,
): Promise<void> {
  try {
    await inferenceChatgptsubscriptionDeviceauthByStateDelete({
      path: { assistant_id: assistantId, state },
      throwOnError: true,
    });
  } catch {
    // Nothing to do: the flow is already gone from the user's view.
  }
}

/**
 * The subscription row the daemon just wrote, for the parent to persist.
 *
 * The listing is unfiltered: the row is found by name, and its `provider`
 * column differs across daemon versions ("chatgpt" on current daemons,
 * "openai" on older ones), so a provider-filtered list can miss it. A listing
 * that fails or does not carry the row yet falls back to a synthesized row
 * rather than reporting a failure: the credential is already stored by the
 * time this runs, so the sign-in did succeed.
 */
export async function resolveChatgptConnection(
  assistantId: string,
): Promise<ProviderConnection> {
  try {
    const { data } = await inferenceProviderconnectionsGet({
      path: { assistant_id: assistantId },
      throwOnError: true,
    });
    const connection = data.connections.find(
      (c) => c.name === "chatgpt-subscription" || c.name === "openai-chatgpt",
    );
    if (connection) {
      return connection;
    }
  } catch {
    // Fall through to the synthesized row.
  }
  const now = Date.now();
  return {
    name: "chatgpt-subscription",
    provider: "chatgpt",
    auth: {
      type: "oauth_subscription",
      credential: CHATGPT_ACCESS_TOKEN_CREDENTIAL,
    },
    label: "ChatGPT Subscription",
    createdAt: now,
    updatedAt: now,
    baseUrl: null,
    models: null,
    isManaged: false,
  };
}
