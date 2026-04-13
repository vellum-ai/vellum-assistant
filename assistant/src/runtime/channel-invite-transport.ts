/**
 * Channel invite adapter abstraction.
 *
 * Defines an adapter interface for building shareable invite links,
 * extracting inbound invite tokens, and resolving channel handles
 * from channel-specific payloads. Each channel (Telegram, voice, etc.)
 * registers an adapter that knows how to handle invite flows for that
 * channel.
 *
 * All methods are optional — the adapter layer is intentionally thin.
 * Redemption logic lives in `invite-redemption-service.ts` and invite
 * instruction generation lives in `invite-instruction-generator.ts`.
 */

import type { ChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { isEmailEnabled } from "../email/feature-gate.js";
import { emailInviteAdapter } from "./channel-invite-transports/email.js";
import { slackInviteAdapter } from "./channel-invite-transports/slack.js";
import { telegramInviteAdapter } from "./channel-invite-transports/telegram.js";
import { voiceInviteAdapter } from "./channel-invite-transports/voice.js";
import { whatsappInviteAdapter } from "./channel-invite-transports/whatsapp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Handle resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve the channel handle for an adapter, preferring the async path
 * when available and falling back to the sync path. Returns `undefined`
 * when the adapter has no handle resolution method or the handle cannot
 * be determined.
 */
export async function resolveAdapterHandle(
  adapter: ChannelInviteAdapter,
): Promise<string | undefined> {
  try {
    if (adapter.resolveChannelHandleAsync) {
      return await adapter.resolveChannelHandleAsync();
    }
    return adapter.resolveChannelHandle?.();
  } catch {
    // Handle resolution is optional metadata — degrade gracefully so
    // callers (e.g. readiness endpoints) don't fail on transient errors.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton registry
// ---------------------------------------------------------------------------

/** Create a registry instance with built-in adapters registered. */
export function createInviteAdapterRegistry(): InviteAdapterRegistry {
  const registry = new InviteAdapterRegistry();
  if (isEmailEnabled(getConfig())) {
    registry.register(emailInviteAdapter);
  }
  registry.register(slackInviteAdapter);
  registry.register(telegramInviteAdapter);
  registry.register(voiceInviteAdapter);
  registry.register(whatsappInviteAdapter);
  return registry;
}

/** Module-level singleton registry, created eagerly at import time. */
const defaultRegistry = createInviteAdapterRegistry();

/** Return the module-level singleton registry. */
export function getInviteAdapterRegistry(): InviteAdapterRegistry {
  return defaultRegistry;
}
