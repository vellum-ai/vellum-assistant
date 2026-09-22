/**
 * Exclusive channel allowlist carried on a signal's `contextPayload`.
 *
 * When `channelAllowlist` is a non-empty string array, delivery is restricted
 * to that set intersected with connected channels. Urgent force and
 * routing-intent expansion do not add channels outside the allowlist.
 * `preferredChannels` stays additive and is ignored when an allowlist is
 * present.
 */

import { readPayloadStringArray } from "./notification-utils.js";
import type { NotificationChannel } from "./types.js";

export function readChannelAllowlist(payload: unknown): string[] | undefined {
  const raw = readPayloadStringArray(payload, "channelAllowlist");
  if (!raw) {
    return undefined;
  }
  const channels = raw.map((entry) => entry.trim()).filter((entry) => {
    return entry.length > 0;
  });
  return channels.length > 0 ? channels : undefined;
}

export function hasExclusiveChannelAllowlist(payload: unknown): boolean {
  return readChannelAllowlist(payload) !== undefined;
}

export function intersectChannelAllowlist(
  allowlist: readonly string[],
  available: readonly NotificationChannel[],
): NotificationChannel[] {
  const availableSet = new Set<string>(available);
  const seen = new Set<string>();
  const selected: NotificationChannel[] = [];
  for (const channel of allowlist) {
    if (!availableSet.has(channel) || seen.has(channel)) {
      continue;
    }
    seen.add(channel);
    selected.push(channel as NotificationChannel);
  }
  return selected;
}
