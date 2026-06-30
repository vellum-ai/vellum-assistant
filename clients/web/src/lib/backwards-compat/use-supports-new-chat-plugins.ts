/**
 * Backwards-compat gate: per-chat plugin selection.
 *
 * Per-chat plugin selection lets a chat carry its own set of enabled
 * plugins, sent on the write path when starting/continuing a
 * conversation. The daemon side that accepts and applies that per-chat
 * plugin set first ships in the assistant version below.
 *
 * The web app always serves the latest bundle, but the assistant can be
 * any locally-installed version. On an older assistant the per-chat
 * plugin set is silently ignored, so the UI that lets the user pick
 * plugins for a chat — and the send path that includes them — must stay
 * gated until the active assistant is known to support it.
 *
 * Because this is a write path whose legacy fallback (sending without
 * the per-chat set) is silently accepted by older daemons, the gate must
 * be read against a RESOLVED version, never the conservative
 * `false`-on-unknown default: use {@link resolveSupportsNewChatPlugins}
 * on the send path so the decision awaits version hydration rather than
 * optimistically assuming support.
 *
 * TODO(version): MIN_VERSION is a near-future placeholder. The current
 * assistant release is 0.10.3; bump this to the exact release that ships
 * the daemon side of per-chat plugin selection once it is cut.
 */
import {
  assistantSupports,
  useAssistantSupports,
  whenAssistantVersionKnown,
} from "./utils";

export const MIN_VERSION = "0.10.4";

/**
 * Returns `true` when the active assistant accepts the per-chat plugin
 * set. Snapshot read shared by the hook and async variants below.
 *
 * Returns `false` while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION`. Not
 * exported: snapshot reads must go through {@link resolveSupportsNewChatPlugins}
 * (send path) so the decision awaits version hydration rather than reading
 * the pre-hydration `false`.
 */
function supportsNewChatPlugins(): boolean {
  return assistantSupports(MIN_VERSION);
}

/**
 * Hook variant of {@link supportsNewChatPlugins}: subscribes to the
 * identity store so consumers re-render when the active assistant's
 * version crosses `MIN_VERSION` (e.g. to show/hide the plugin picker).
 */
export function useSupportsNewChatPlugins(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

/**
 * Async variant of {@link supportsNewChatPlugins} for the send path:
 * waits (bounded) for the assistant version to hydrate before reading
 * the gate.
 *
 * The sync snapshot returns `false` until the version resolves, which
 * would drop the per-chat plugin set on the very first send after a cold
 * start even against a capable assistant. Awaiting the version first
 * ensures the decision is made against a resolved version — never an
 * optimistic `true`, and never the pre-hydration `false`.
 */
export async function resolveSupportsNewChatPlugins(): Promise<boolean> {
  await whenAssistantVersionKnown();
  return supportsNewChatPlugins();
}
