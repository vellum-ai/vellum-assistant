/**
 * Lightweight pub/sub for the one local-gateway failure the renderer cannot
 * clear on its own: the `/auth/token` mint rejecting the guardian token with a
 * `401` that outlives the automatic in-place recovery.
 *
 * That recovery runs a plain `wake`, which restarts the assistant and its
 * gateway but never re-provisions the guardian token, because the re-lease
 * revokes the assistant's other device-bound tokens and so is reserved for an
 * explicitly confirmed repair. A `401` that survives it therefore keeps
 * rejecting every request for as long as the session stands.
 *
 * The response interceptor that discovers this has no route to the user, so it
 * announces here. The subscriber is the app-root adapter that sends the
 * session to the assistant chooser, whose connect path owns the
 * guardian-repair dialog.
 */

import { createNotifier } from "@/lib/create-notifier";

const channel = createNotifier();

export function subscribeGatewayRepairRequired(
  listener: () => void,
): () => void {
  return channel.subscribe(listener);
}

export function notifyGatewayRepairRequired(): void {
  channel.notify();
}
