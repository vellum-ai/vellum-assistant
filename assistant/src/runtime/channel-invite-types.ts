/**
 * Types extracted from channel-invite-transport.ts to break the
 * transport ↔ channel-invite-transports/* cycles (×5).
 */

import type { ChannelId } from "../channels/types.js";

export interface InviteShareLink {
  /** The full URL the recipient can open to redeem the invite. */
  url: string;
  /** Human-readable text suitable for display alongside the link. */
  displayText: string;
}

export interface ChannelInviteAdapter {
  /** The channel this adapter handles. */
  channel: ChannelId;

  /**
   * Build a channel-specific shareable link (e.g. Telegram deep link).
   * Optional — not all channels support link-based invites.
   */
  buildShareLink?(params: {
    rawToken: string;
    sourceChannel: ChannelId;
  }): InviteShareLink;

  /**
   * Extract a channel-specific invite token from an inbound message
   * (e.g. Telegram `/start iv_<token>`). Optional — only needed for
   * channels with link-based invites.
   */
  extractInboundToken?(params: {
    commandIntent?: Record<string, unknown>;
    content: string;
    sourceMetadata?: Record<string, unknown>;
  }): string | undefined;

  /**
   * Resolve the channel-specific handle to reach the assistant (e.g.
   * // generic-examples:ignore-next-line — reason: illustrative docstring examples, not real data
   * "@botName", "+15551234567", "hello@vellum.me").
   * Returns `undefined` when the handle cannot be resolved (e.g.
   * credentials not yet configured).
   */
  resolveChannelHandle?(): string | undefined;

  /**
   * Async variant of `resolveChannelHandle` for adapters that need to
   * perform I/O (e.g. querying a provider API for the assigned address).
   * When both are present, `resolveAdapterHandle()` prefers this method.
   */
  resolveChannelHandleAsync?(): Promise<string | undefined>;
}
