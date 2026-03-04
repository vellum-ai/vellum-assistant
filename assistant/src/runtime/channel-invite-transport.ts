/**
 * Channel invite transport abstraction.
 *
 * Defines a transport interface for building shareable invite links and
 * extracting inbound invite tokens from channel-specific payloads. Each
 * channel (Telegram, SMS, Slack, etc.) registers an adapter that knows
 * how to construct deep links and parse incoming tokens for that channel.
 *
 * The transport layer is intentionally thin: it handles URL construction
 * and token extraction only. Redemption logic lives in
 * `invite-redemption-service.ts`.
 */

import type { ChannelId } from "../channels/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InviteSharePayload {
  /** The full URL the recipient can open to redeem the invite. */
  url: string;
  /** Human-readable text suitable for display alongside the link. */
  displayText: string;
}

export interface ChannelInviteTransport {
  /** The channel this transport handles. */
  channel: ChannelId;

  /**
   * Build a shareable invite payload (URL + display text) from a raw token.
   *
   * The raw token is the base64url-encoded secret returned by
   * `invite-store.createInvite`. The transport wraps it in a
   * channel-specific deep link so the recipient can redeem the invite
   * by clicking/tapping the link.
   */
  buildShareableInvite(params: {
    rawToken: string;
    sourceChannel: ChannelId;
  }): InviteSharePayload;

  /**
   * Extract an invite token from an inbound channel message.
   *
   * Returns the raw token string (without the `iv_` prefix) if the
   * message contains a valid invite token, or `undefined` otherwise.
   */
  extractInboundToken(params: {
    commandIntent?: Record<string, unknown>;
    content: string;
    sourceMetadata?: Record<string, unknown>;
  }): string | undefined;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<ChannelId, ChannelInviteTransport>();

/**
 * Register a channel invite transport. Overwrites any previously registered
 * transport for the same channel.
 */
export function registerTransport(transport: ChannelInviteTransport): void {
  registry.set(transport.channel, transport);
}

/**
 * Look up the registered transport for a channel. Returns `undefined` when
 * no transport has been registered for the given channel.
 */
export function getTransport(
  channel: ChannelId,
): ChannelInviteTransport | undefined {
  return registry.get(channel);
}

/**
 * Reset the registry. Intended for tests only.
 * @internal
 */
export function _resetRegistry(): void {
  registry.clear();
}
