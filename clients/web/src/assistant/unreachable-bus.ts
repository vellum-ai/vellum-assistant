/**
 * Lightweight pub/sub that lets the HTTP client signal the reachability
 * hook when an upstream request to the assistant's runtime pod fails
 * with a gateway-like status code (pod restarting, not yet ready,
 * etc.).
 *
 * The reachability hook subscribes on mount and fires its retry probe
 * so that the connecting overlay shows up even when the failure is on
 * an incidental request (initial page load, background refetch) and
 * not on the main SSE `/events` stream.
 */

import { createNotifier } from "@/lib/create-notifier";

const channel = createNotifier();

export function subscribeAssistantUnreachable(
  listener: () => void,
): () => void {
  return channel.subscribe(listener);
}

export function notifyAssistantUnreachable(): void {
  channel.notify();
}

/**
 * Gateway-ish statuses that indicate the request reached the platform
 * but couldn't reach the assistant pod. 502/503/504 all map to "pod
 * is restarting / not yet ready".
 */
export const UNREACHABLE_STATUS_CODES = new Set<number>([502, 503, 504]);
