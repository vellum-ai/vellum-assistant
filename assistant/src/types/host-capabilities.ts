/**
 * Which client provides which host capability.
 *
 * This is the single source of truth for host routing. `supportsHostProxy` in
 * `channels/types.ts` answers from this table, and the `assistant clients` help
 * text renders it so the assistant can tell a user which client unblocks a
 * task. It lives in the shared leaf zone because the CLI reads it on every
 * `assistant clients --help`, and the CLI may not hoist daemon-internal
 * modules into its static import graph.
 *
 * Pure data and pure functions only: no imports, no daemon runtime graph.
 */

export const HOST_PROXY_CAPABILITIES = [
  "host_bash",
  "host_file",
  "host_cu",
  "host_cu_window_capture",
  "host_cu_annotate",
  "host_browser",
  "host_app_control",
  "host_ui_snapshot",
] as const;

export type HostProxyCapability = (typeof HOST_PROXY_CAPABILITIES)[number];

/** Every host capability except the three macOS-only ones. */
const DESKTOP_SHARED_CAPABILITIES = HOST_PROXY_CAPABILITIES.filter(
  (capability) =>
    capability !== "host_app_control" &&
    capability !== "host_cu_window_capture" &&
    capability !== "host_cu_annotate",
);

/**
 * Interfaces that support desktop host-proxy tools. Used by the discriminated
 * transport metadata union and by the `supportsHostProxy(id)` type predicate.
 */
export type HostProxyInterfaceId = "macos" | "windows" | "linux";

/**
 * Capabilities each client provides.
 *
 * chrome-extension is here because it serves `host_browser`, but it is not a
 * `HostProxyInterfaceId`: the no-arg `supportsHostProxy(id)` gate that
 * desktop-only call sites use still rejects it. Clients absent from this table
 * (web, ios, android, and every messaging transport) provide none.
 *
 * Windows and Linux run the same host proxy as macOS minus app control. The
 * two window-scoped CU capabilities ride the host_cu transport and are
 * negotiated per connection; only the macOS native helper answers them, so a
 * request elsewhere would reach that helper as an unknown action.
 *
 * macOS additionally provisions its `host_browser` proxy via the assistant
 * event hub. When no extension is connected, browser tools fall through to
 * cdp-inspect/local via the CDP factory's candidate chain.
 */
export const HOST_PROXY_SUPPORT = {
  macos: HOST_PROXY_CAPABILITIES,
  windows: DESKTOP_SHARED_CAPABILITIES,
  linux: DESKTOP_SHARED_CAPABILITIES,
  "chrome-extension": ["host_browser"],
} as const satisfies Record<string, readonly HostProxyCapability[]>;

// Every desktop interface must appear in the table above. A new one added to
// the union without a capability entry fails to compile here.
const _everyDesktopInterfaceHasCapabilities: Record<
  HostProxyInterfaceId,
  keyof typeof HOST_PROXY_SUPPORT
> = { macos: "macos", windows: "windows", linux: "linux" };
void _everyDesktopInterfaceHasCapabilities;

/**
 * Whether the interface is a native desktop host-proxy client. Distinct from
 * "provides some capability": chrome-extension serves `host_browser` but is
 * not a desktop client, so desktop-only call sites reject it.
 */
export function isHostProxyInterfaceId(id: string): id is HostProxyInterfaceId {
  return id === "macos" || id === "windows" || id === "linux";
}

/**
 * Capabilities the interface provides, empty when it provides none.
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so an id like
 * "toString" or "constructor" would resolve to an inherited function rather
 * than a capability list, and the caller's `.includes` would throw.
 */
export function hostProxyCapabilities(
  id: string,
): readonly HostProxyCapability[] {
  return Object.hasOwn(HOST_PROXY_SUPPORT, id)
    ? HOST_PROXY_SUPPORT[id as keyof typeof HOST_PROXY_SUPPORT]
    : [];
}
