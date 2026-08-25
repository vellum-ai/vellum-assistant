import { publish } from "@/lib/event-bus";
import { subscribeToDownloadEvents } from "@/runtime/downloads";

/**
 * Electron main-process download reports → `download.done` bus events.
 * Off Electron the runtime wrapper is a no-op and the returned
 * unsubscribe-noop drops through cleanly: a browser download publishes
 * `download.started` from `saveFile` at handoff instead, and Capacitor's
 * share sheet is its own feedback.
 */
export function publishElectronDownloadsSource(): () => void {
  return subscribeToDownloadEvents((event) => {
    publish("download.done", event);
  });
}
