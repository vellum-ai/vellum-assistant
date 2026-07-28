/**
 * Backwards-compat gate: channel-setup wizard close auto-notify.
 *
 * The wizard-close signal is a hidden (`hidden: true`) send on
 * `POST /messages`. The daemon side that keeps a hidden send suppressed
 * end-to-end — echo skip, persisted-row filtering, and crucially the
 * queued-message path (hidden carried through enqueue metadata, drain
 * echo suppression, queued-snapshot filtering) plus the pending-
 * interaction supersede bypass — first ships in the assistant version
 * below. Older daemons ignore the flag partially or entirely, which
 * would render the synthetic `[User action on channel_setup surface: …]`
 * marker as a visible user bubble and let a passive drawer close
 * auto-deny live approval prompts.
 *
 * Skipping the notify on an older assistant is the correct legacy
 * behavior: the slack-app-setup skill keeps its manual "tell me when
 * you're done / ask me to check" fallback, which is exactly the
 * pre-feature flow.
 *
 * Because this is a write path whose legacy fallback (not sending) is
 * silent, the gate must be read against a RESOLVED version: use
 * {@link resolveSupportsChannelSetupCloseNotify} on the send path so the
 * decision awaits version hydration rather than reading the
 * pre-hydration `false` (or optimistically assuming support).
 *
 * TODO(version): MIN_VERSION is a near-future placeholder. The current
 * assistant release is 0.10.3; bump this to the exact release that ships
 * the daemon side of the hidden-send queue handling once it is cut.
 */
import { assistantSupports, whenAssistantVersionKnown } from "./utils";

export const MIN_VERSION = "0.10.4";

/**
 * Async gate for the notify send path: waits (bounded) for the assistant
 * version to hydrate, then reports whether the active assistant handles
 * hidden sends end-to-end (including the queued path).
 */
export async function resolveSupportsChannelSetupCloseNotify(): Promise<boolean> {
  await whenAssistantVersionKnown();
  return assistantSupports(MIN_VERSION);
}
