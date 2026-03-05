/**
 * Channel invite adapter abstraction.
 *
 * Defines an adapter interface for building shareable invite links,
 * extracting inbound invite tokens, and generating guardian instructions
 * from channel-specific payloads. Each channel (Telegram, voice, etc.)
 * registers an adapter that knows how to handle invite flows for that
 * channel.
 *
 * All methods are optional: a channel that only provides
 * `buildGuardianInstruction` (e.g. SMS) is a valid adapter. The adapter
 * layer is intentionally thin — redemption logic lives in
 * `invite-redemption-service.ts`.
 */

import type { ChannelId } from "../channels/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InviteShareLink {
  /** The full URL the recipient can open to redeem the invite. */
  url: string;
  /** Human-readable text suitable for display alongside the link. */
  displayText: string;
}

export interface GuardianInstruction {
  /** Human-readable instruction text for the guardian. */
  instruction: string;
  /** Channel-specific handle to reach the assistant (e.g. "@botName", "+15551234567", "hello@domain.agentmail.to"). */
  channelHandle?: string;
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
   * Build guardian instruction for this channel. Returns structured data
   * with the instruction text and an optional channel-specific handle.
   * Optional — falls back to generic instruction if not implemented.
   */
  buildGuardianInstruction?(params: {
    inviteCode: string;
    contactName?: string;
  }): GuardianInstruction;

  /**
   * Resolve the channel-specific handle to reach the assistant (e.g.
   * "@botName", "+15551234567", "hello@domain.agentmail.to").
   * Returns `undefined` when the handle cannot be resolved (e.g.
   * credentials not yet configured).
   */
  resolveChannelHandle?(): string | undefined;
}

// ---------------------------------------------------------------------------
// Backward-compatible type aliases
// ---------------------------------------------------------------------------

/** @deprecated Use `ChannelInviteAdapter` instead. */
export type ChannelInviteTransport = ChannelInviteAdapter;

/** @deprecated Use `InviteShareLink` instead. */
export type InviteSharePayload = InviteShareLink;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class InviteAdapterRegistry {
  private adapters = new Map<ChannelId, ChannelInviteAdapter>();

  /**
   * Register a channel invite adapter. Overwrites any previously
   * registered adapter for the same channel.
   */
  register(adapter: ChannelInviteAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  /**
   * Look up the registered adapter for a channel. Returns `undefined`
   * when no adapter has been registered for the given channel.
   */
  get(channel: ChannelId): ChannelInviteAdapter | undefined {
    return this.adapters.get(channel);
  }

  /** Return all registered adapters. */
  getAll(): ChannelInviteAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Reset the registry. Intended for tests only.
   * @internal
   */
  _reset(): void {
    this.adapters.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton registry + backward-compatible free functions
// ---------------------------------------------------------------------------

import { emailInviteAdapter } from "./channel-invite-transports/email.js";
import { slackInviteAdapter } from "./channel-invite-transports/slack.js";
import { smsInviteAdapter } from "./channel-invite-transports/sms.js";
import { telegramInviteAdapter } from "./channel-invite-transports/telegram.js";
import { voiceInviteAdapter } from "./channel-invite-transports/voice.js";

/** Create a registry instance with built-in adapters registered. */
export function createInviteAdapterRegistry(): InviteAdapterRegistry {
  const registry = new InviteAdapterRegistry();
  registry.register(emailInviteAdapter);
  registry.register(slackInviteAdapter);
  registry.register(smsInviteAdapter);
  registry.register(telegramInviteAdapter);
  registry.register(voiceInviteAdapter);
  return registry;
}

/**
 * Module-level singleton registry, created eagerly so callers that
 * import the free functions continue to work without changes.
 */
const defaultRegistry = createInviteAdapterRegistry();

/** Return the module-level singleton registry. */
export function getInviteAdapterRegistry(): InviteAdapterRegistry {
  return defaultRegistry;
}

/**
 * Register a channel invite adapter on the default registry.
 * @deprecated Prefer `getInviteAdapterRegistry().register(adapter)`.
 */
export function registerTransport(transport: ChannelInviteAdapter): void {
  defaultRegistry.register(transport);
}

/**
 * Look up the registered adapter for a channel on the default registry.
 * @deprecated Prefer `getInviteAdapterRegistry().get(channel)`.
 */
export function getTransport(
  channel: ChannelId,
): ChannelInviteAdapter | undefined {
  return defaultRegistry.get(channel);
}

/**
 * Reset the default registry. Intended for tests only.
 * @internal
 */
export function _resetRegistry(): void {
  defaultRegistry._reset();
}
