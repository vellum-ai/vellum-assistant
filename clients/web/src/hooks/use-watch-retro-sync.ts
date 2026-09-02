/**
 * Bus consumer for `watch_retro_completed` SSE events.
 *
 * The end of the wait a stopped watch session starts. The runtime writes the
 * account of a session in a turn that begins after the recording socket is
 * already gone, so this stream is the only channel still open when it finishes;
 * see `domains/chat/watch/watch-retro.ts` for the whole shape of that wait.
 *
 * Mounted once, in `RootLayout`, beside the other bus consumers. It has to run
 * wherever the user happens to be: the announcement names a background
 * conversation they are almost never sitting in, since a session is narrated
 * while working in another app entirely.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 */

import { settleWatchRetro } from "@/domains/chat/watch/watch-retro";
import { useBusSubscription } from "@/hooks/use-bus-subscription";

export function useWatchRetroSync(): void {
  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "watch_retro_completed") {
      return;
    }
    settleWatchRetro(event);
  });
}
