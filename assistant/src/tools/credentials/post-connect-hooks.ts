/**
 * Post-connect hooks for OAuth2 services.
 *
 * This module decouples provider-specific post-connection side effects
 * (e.g. sending a welcome DM after Slack OAuth) from the generic vault
 * OAuth2 flow. Each hook is keyed by canonical service name and receives
 * the raw token response so it can perform provider-specific actions.
 */

import {
  authTest,
  conversationsOpen,
  postMessage,
} from "../../messaging/providers/slack/client.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("post-connect-hooks");

export interface PostConnectHookContext {
  service: string;
  rawTokenResponse: Record<string, unknown>;
}

type PostConnectHook = (ctx: PostConnectHookContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Provider-specific hooks
// ---------------------------------------------------------------------------

async function slackWelcomeDM(ctx: PostConnectHookContext): Promise<void> {
  const botToken = ctx.rawTokenResponse.access_token as string | undefined;
  const authedUser = ctx.rawTokenResponse.authed_user as
    | Record<string, unknown>
    | undefined;
  const installingUserId = authedUser?.id as string | undefined;
  if (!botToken || !installingUserId) return;

  const identity = await authTest(botToken);
  const dmChannel = await conversationsOpen(botToken, installingUserId);
  const welcomeMsg =
    `You have installed ${identity.user}, an AI Assistant, on ${identity.team}. ` +
    `You can manage the assistant experience for this workspace by chatting with the assistant or from the Settings page.`;
  await postMessage(botToken, dmChannel.channel.id, welcomeMsg);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const POST_CONNECT_HOOKS: Record<string, PostConnectHook> = {
  slack: slackWelcomeDM,
};

/**
 * Run the post-connect hook for a service, if one is registered.
 * Failures are logged but never propagated -- they must not break the OAuth flow.
 */
export async function runPostConnectHook(
  ctx: PostConnectHookContext,
): Promise<void> {
  const hook = POST_CONNECT_HOOKS[ctx.service];
  if (!hook) return;

  try {
    await hook(ctx);
  } catch (err) {
    log.warn(
      { err, service: ctx.service },
      "Post-connect hook failed (non-fatal)",
    );
  }
}
