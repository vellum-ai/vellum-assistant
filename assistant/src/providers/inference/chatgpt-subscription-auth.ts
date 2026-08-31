/**
 * In-daemon completion of the "ChatGPT Subscription" sign-in: store the tokens
 * and point the provider connection at them in one step.
 *
 * The OAuth client config and the credential writes live in
 * `chatgpt-subscription-credentials.ts`, which depends on nothing but the
 * credential store so the CLI can import it without pulling in the database.
 */

import { getDb } from "../../persistence/db-connection.js";
import type { OAuth2TokenResult } from "../../security/oauth2.js";
import { getLogger } from "../../util/logger.js";
import {
  CHATGPT_SUBSCRIPTION_AUTH_INPUT,
  CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
  storeChatgptSubscriptionCredentials,
} from "./chatgpt-subscription-credentials.js";
import {
  createConnection,
  getConnection,
  updateConnection,
} from "./connections.js";

const log = getLogger("chatgpt-subscription-auth");

/**
 * Store the subscription's tokens and point the `chatgpt-subscription` provider
 * connection at them, creating the connection when it does not exist yet.
 */
export async function storeChatgptSubscriptionTokens(
  tokens: OAuth2TokenResult,
): Promise<void> {
  await storeChatgptSubscriptionCredentials(tokens);

  const db = getDb();
  const existing = getConnection(db, CHATGPT_SUBSCRIPTION_CONNECTION_NAME);

  if (existing) {
    // Stamp the provider with the auth: this row IS the subscription route
    // (auth modality = provider identity), and dispatch derives the openai
    // upstream from the identity per-request. Stamping also heals a
    // claiming row whose provider would otherwise misroute the fresh token.
    const updateResult = updateConnection(
      db,
      CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
      { auth: CHATGPT_SUBSCRIPTION_AUTH_INPUT, provider: "chatgpt" },
    );
    if (!updateResult.ok) {
      log.error(
        { error: updateResult.error },
        "Failed to update chatgpt-subscription connection",
      );
      throw new Error("Failed to update connection");
    }
    return;
  }

  const createResult = createConnection(db, {
    name: CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
    provider: "chatgpt",
    auth: CHATGPT_SUBSCRIPTION_AUTH_INPUT,
  });
  if (!createResult.ok) {
    log.error(
      { error: createResult.error },
      "Failed to create chatgpt-subscription connection",
    );
    throw new Error("Failed to create connection");
  }
}
