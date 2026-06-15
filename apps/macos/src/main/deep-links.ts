import { BrowserWindow, app, type WebContents } from "electron";
import { z } from "zod";

import type { DeepLink } from "@vellumai/ipc-contract";
import { resolveEnvironmentName } from "@vellumai/local-mode";

import { handle, on } from "./ipc";
import { ensureVisible as ensureMainWindowVisible } from "./main-window";

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

export type { DeepLink };

const PRODUCTION_SCHEME = "vellum-assistant";

function schemeForEnv(env: string): string {
  return env === "production" ? PRODUCTION_SCHEME : `${PRODUCTION_SCHEME}-${env}`;
}

// Schemes to REGISTER with the OS via `app.setAsDefaultProtocolClient`.
// Production claims both `vellum` and `vellum-assistant`; non-production
// claims only the env-specific scheme to avoid hijacking production.
export function resolveRegisteredSchemes(env: string): string[] {
  if (env === "production") return ["vellum", PRODUCTION_SCHEME];
  return [schemeForEnv(env)];
}

// Schemes to ACCEPT when parsing inbound URLs. Superset of registered
// schemes — always includes `vellum:` and `vellum-assistant:` so URLs
// routed to this build still parse correctly.
export function resolveAcceptedSchemes(env: string): string[] {
  const accepted = new Set(["vellum:", `${PRODUCTION_SCHEME}:`]);
  if (env !== "production") accepted.add(`${schemeForEnv(env)}:`);
  return [...accepted];
}

const currentEnv = resolveEnvironmentName(process.env);
const REGISTERED_SCHEMES = resolveRegisteredSchemes(currentEnv);
const ACCEPTED_SCHEMES = resolveAcceptedSchemes(currentEnv);

/**
 * Pure parser: URL string → typed `DeepLink`. Exported for unit tests.
 *
 * Rules:
 *
 *   - Scheme MUST be in the accepted set (`vellum:`, `vellum-assistant:`,
 *     plus the env-specific scheme like `vellum-assistant-dev:`).
 *     Anything else (`javascript:`, `data:`, `file:`, foreign customs)
 *     is rejected as `kind: "unknown"` — the renderer additionally
 *     defensively validates before dispatching.
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
  if (!ACCEPTED_SCHEMES.includes(url.protocol)) {
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
  if (url.host === "auth" && url.pathname.startsWith("/callback")) {
    // The deprecated `/accounts/native/*` flow returns its auth code here.
    // Strip the sensitive code from the query so it doesn't get captured downstream.
    return { kind: "unknown", url: `${url.protocol}//${url.host}${url.pathname}` };
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
    if (ACCEPTED_SCHEMES.some((s) => arg.startsWith(s))) return arg;
  }
  return null;
};

const pending: DeepLink[] = [];

// Active renderer subscribers tracked by their `WebContents` rather
// than a counter. Renderer calls `vellum:deepLinks:subscribe` when
// its `onLink` handler registers; we add the `event.sender` and
// listen for that webContents's `destroyed` event so cleanup runs
// even when React effect teardown doesn't fire (window-close kills
// the JS context before `useEffect` cleanups flush — a leaked
// counter would flip buffering off and silently drop later links).
// `vellum:deepLinks:unsubscribe` covers the common mount/unmount
// path; the `destroyed` listener is the defense-in-depth.
//
// Buffer when the set is empty; broadcast-only when non-empty. This
// keeps both the live-link-replay defense AND the
// renderer-down-link-buffers behavior the consumer relies on.
//
// Residual race (sub-microsecond, not realistically triggerable by
// user action): a link arriving between the renderer's
// `ipcRenderer.on` registration and main's processing of the
// `subscribe` IPC could be buffered AND broadcast. A single
// renderer-side dedup would catch this if it ever bit; today the
// timing makes it theoretical.
const subscribers = new Set<WebContents>();

const broadcast = (link: DeepLink): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("vellum:deepLinks:event", link);
  }
};

/**
 * Main entry — parse, buffer-if-no-subscribers, broadcast, and
 * bring the main window forward for actionable kinds. Internal to
 * this module; exposed via the `open-url` / `second-instance`
 * event handlers and exported for tests.
 *
 * Window activation lives HERE (not only in the renderer-side
 * consumer) because on macOS the app keeps running after the main
 * window closes (`window-all-closed` doesn't quit on Darwin). In
 * that state the renderer doesn't exist, so a renderer-only
 * `ensureMainWindowVisible()` would never fire; the buffered link
 * would sit forever. `unknown` kinds skip activation: an attacker
 * who could induce the OS to route a `javascript:` URL to us
 * shouldn't get a UI side effect.
 *
 * Main owns the cold path (no-renderer activation), renderer owns
 * the hot path (window minimized / behind another window — see
 * `useGlobalDeepLinkConsumer`). The duplicated call when both fire
 * is intentional defense-in-depth — `ensureVisible` short-circuits
 * on an already-visible main window.
 */
export const handleDeepLink = (input: string): void => {
  const link = parseVellumUrl(input);

  if (subscribers.size === 0) pending.push(link);
  broadcast(link);
  // Activation is gated on `app.isReady()`. On cold launch, the
  // `will-finish-launching` → `open-url` path fires BEFORE
  // `app.whenReady()`, and `new BrowserWindow()` pre-ready races
  // Electron's init. The link is already buffered above; the
  // initial `installMainWindow()` in the `whenReady` chain in
  // `index.ts` creates the first window, which drains the link
  // on mount.
  if (link.kind !== "unknown" && app.isReady()) {
    void ensureMainWindowVisible();
  }
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

  // Dynamic registration — only claim the schemes this build owns.
  // Non-production builds register only their env-specific scheme
  // (e.g. `vellum-assistant-dev`) to avoid hijacking production
  // callbacks when both apps coexist.
  for (const scheme of REGISTERED_SCHEMES) {
    app.setAsDefaultProtocolClient(scheme);
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
  handle("vellum:deepLinks:drain", z.tuple([]), (): DeepLink[] => {
    return pending.splice(0, pending.length);
  });

  // Subscriber tracking — see the `subscribers` comment above for
  // the model. The fire-and-forget `on` channel is sufficient — these
  // are accounting messages, no return value expected. The preload
  // sends them inside `onLink` registration / cleanup; the
  // `destroyed` listener is the defense-in-depth for the cases
  // where the React effect cleanup doesn't run before the
  // webContents is torn down.
  on("vellum:deepLinks:subscribe", z.tuple([]), (_args, event) => {
    if (subscribers.has(event.sender)) return;
    subscribers.add(event.sender);
    event.sender.once("destroyed", () => {
      subscribers.delete(event.sender);
    });
  });
  on("vellum:deepLinks:unsubscribe", z.tuple([]), (_args, event) => {
    subscribers.delete(event.sender);
  });
};

// Test seam — exported only for unit-test setup. Production code
// uses `installDeepLinks` instead.
export const __resetForTesting = (): void => {
  installed = false;
  subscribers.clear();
  pending.length = 0;
};
