import { BrowserWindow, app, ipcMain } from "electron";

/**
 * Inbound deep links — `vellum://` and `vellum-assistant://` URL
 * schemes. The OS routes any user click on a `vellum://send?message=hi`
 * link (Mail, Slack, browser address bar, `open vellum://...` shell
 * command) to the running Electron app, where we parse it into a
 * typed `DeepLink` and broadcast to the renderer.
 *
 * Why this exists as a separate module (rather than reusing the
 * application-menu command bus): deep links have parsing, buffering,
 * and pre-`whenReady` arrival semantics that menu commands don't.
 * The convention in `ELECTRON.md` for cross-domain push signals
 * applies — the renderer's bus is the consumer surface; this module
 * is the signal source.
 *
 * Lifecycle hooks (all required):
 *
 *   - `app.setAsDefaultProtocolClient(scheme)` registers the schemes
 *     with Launch Services dynamically. Required for dev builds (the
 *     dev `.app` bundle isn't installed normally); also defensive
 *     registration for packaged builds.
 *   - `app.on("will-finish-launching", () => app.on("open-url", ...))`
 *     captures URLs delivered AT launch (the OS opens the app via a
 *     link click → `open-url` fires before `ready`). Registering in
 *     `whenReady` misses the launching URL — the #1 deep-link bug.
 *   - `app.on("second-instance")` forwards URLs from a second-launch
 *     attempt. macOS delivers the URL via a fresh `open-url` on the
 *     primary instance (argv is empty); Windows / Linux deliver via
 *     argv only (`open-url` never fires). We handle both.
 *
 * Buffering: deep links arriving before the renderer is ready (or
 * before the first `vellum:deepLinks:drain` IPC call) are queued in
 * a module-scope `pending[]`. The renderer drains via
 * `window.vellum.deepLinks.drain()` once mounted. Live links arriving
 * after drain are pushed to the buffer too AND broadcast to every
 * BrowserWindow's `vellum:deepLinks:event` channel; consumers
 * subscribe-then-drain to avoid races.
 *
 * Reference:
 *   - https://www.electronjs.org/docs/latest/api/app#event-will-finish-launching
 *   - https://www.electronjs.org/docs/latest/api/app#appsetasdefaultprotocolclientprotocol-path-args
 */

export type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  | { kind: "unknown"; url: string };

const ACCEPTED_SCHEMES = ["vellum:", "vellum-assistant:"] as const;

/**
 * Pure parser: URL string → typed `DeepLink`. Exported for unit tests.
 *
 * Rules:
 *
 *   - Scheme MUST be `vellum:` or `vellum-assistant:`. Anything else
 *     (`javascript:`, `data:`, `file:`, foreign customs) is rejected
 *     as `kind: "unknown"` — the renderer additionally defensively
 *     validates before dispatching.
 *   - `vellum://send?message=…` → `{ kind: "send", message }`. Empty
 *     `message` is preserved (renderer can decide to open an empty
 *     composer).
 *   - `vellum://thread/<id>` → `{ kind: "openThread", threadId }`.
 *     Trailing slashes / extra path segments are tolerated;
 *     `threadId` is the first non-empty path segment.
 *   - Malformed URL (unparseable, percent-encoding throws) →
 *     `kind: "unknown"`.
 */
export const parseVellumUrl = (input: string): DeepLink => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "unknown", url: input };
  }
  if (!ACCEPTED_SCHEMES.includes(url.protocol as (typeof ACCEPTED_SCHEMES)[number])) {
    return { kind: "unknown", url: input };
  }
  if (url.host === "send") {
    return { kind: "send", message: url.searchParams.get("message") ?? "" };
  }
  if (url.host === "thread") {
    const threadId = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (threadId) return { kind: "openThread", threadId };
    return { kind: "unknown", url: input };
  }
  return { kind: "unknown", url: input };
};

/**
 * Find the first deep-link URL in an argv. Used on Windows / Linux
 * where the OS delivers second-instance deep links via argv rather
 * than via `app.on("open-url")` like macOS. Exported for unit tests.
 */
export const extractDeepLinkFromArgv = (argv: readonly string[]): string | null => {
  for (const arg of argv) {
    if (ACCEPTED_SCHEMES.some((scheme) => arg.startsWith(scheme))) return arg;
  }
  return null;
};

const pending: DeepLink[] = [];

// Active renderer subscribers. Renderer calls `vellum:deepLinks:subscribe`
// when its `onLink` handler is registered and `vellum:deepLinks:unsubscribe`
// on cleanup. Buffer when count is zero (no subscribers to receive the
// broadcast); broadcast-only when count > 0.
//
// This is what closes both the Codex P2 (live-link replay on renderer
// reload — broadcast doesn't enter the buffer when a subscriber is
// listening) AND the logout-relogin gap (after the renderer unmounts,
// links arriving during the auth flip land in the buffer and the next
// renderer drains them on mount). A "drained once, never buffer
// again" flag is wrong because it conflates "has ever drained" with
// "is subscribed right now."
//
// Residual race (sub-microsecond, not realistically triggerable by
// user action): a link arriving between the renderer's
// `ipcRenderer.on` registration and main's processing of the
// `subscribe` IPC could be buffered AND broadcast. A single
// renderer-side dedup would catch this if it ever bit; today the
// timing makes it theoretical.
let subscriberCount = 0;

const broadcast = (link: DeepLink): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("vellum:deepLinks:event", link);
  }
};

/**
 * Main entry — parse, buffer-if-no-subscribers, broadcast. Internal
 * to this module; exposed via the `open-url` / `second-instance`
 * event handlers and exported for tests.
 */
export const handleDeepLink = (input: string): void => {
  const link = parseVellumUrl(input);
  if (subscriberCount === 0) pending.push(link);
  broadcast(link);
};

let installed = false;

/**
 * Wire the deep-link handlers. Called at module-top-level (NOT from
 * `whenReady`) so the `will-finish-launching` subscription captures
 * URLs delivered AT launch.
 */
export const installDeepLinks = (): void => {
  if (installed) return;
  installed = true;

  // Dynamic registration. Packaged builds also declare these in
  // `electron-builder.yml`'s `protocols` (so `Info.plist` carries
  // `CFBundleURLTypes`); the dynamic call is required for dev and
  // defensive for prod.
  for (const scheme of ACCEPTED_SCHEMES) {
    app.setAsDefaultProtocolClient(scheme.replace(/:$/, ""));
  }

  app.on("will-finish-launching", () => {
    app.on("open-url", (event, url) => {
      event.preventDefault();
      handleDeepLink(url);
    });
  });

  // Renderer drains on mount. Returns AND clears whatever's in the
  // buffer. The next link's `handleDeepLink` decision (buffer vs
  // broadcast-only) is governed by `subscriberCount`, not by
  // whether drain has been called.
  ipcMain.handle("vellum:deepLinks:drain", (): DeepLink[] => {
    return pending.splice(0, pending.length);
  });

  // Subscriber tracking — see the `subscriberCount` comment above
  // for the model. `ipcMain.on` (fire-and-forget) is sufficient —
  // these are accounting messages, no return value expected. The
  // preload sends them inside `onLink` registration / cleanup.
  ipcMain.on("vellum:deepLinks:subscribe", () => {
    subscriberCount++;
  });
  ipcMain.on("vellum:deepLinks:unsubscribe", () => {
    subscriberCount = Math.max(0, subscriberCount - 1);
  });
};

// Test seam — exported only for unit-test setup. Production code
// uses `installDeepLinks` instead.
export const __resetForTesting = (): void => {
  installed = false;
  subscriberCount = 0;
  pending.length = 0;
};
