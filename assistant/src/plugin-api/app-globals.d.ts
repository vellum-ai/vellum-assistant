/**
 * Ambient global types for the **app-side** Vellum bridge — `window.vellum`.
 *
 * A Vellum plugin app runs inside a sandboxed iframe, and the host injects a
 * `window.vellum` object into it at load time (see the assistant's
 * `sandbox-bridge` runtime). This file is the type-only counterpart to that
 * injection: it teaches TypeScript the shape of `window.vellum` so an app can
 * call `window.vellum.fetch(...)`, `window.vellum.sendAction(...)`, etc.
 * without hand-declaring the global in every project.
 *
 * A plugin app that depends on `@vellumai/plugin-api` pulls this in one of two
 * ways:
 *
 * 1. Referenced explicitly (recommended for apps that don't otherwise import
 *    from the package — e.g. a plain Vite app that only calls
 *    `window.vellum.fetch`):
 *
 *    ```ts
 *    /// <reference types="@vellumai/plugin-api/app" />
 *    ```
 *
 *    or add `"@vellumai/plugin-api/app"` to `compilerOptions.types` in
 *    `tsconfig.json`.
 *
 * 2. Transitively — importing anything from `@vellumai/plugin-api` also loads
 *    this augmentation, because the package's main type entry references it.
 *
 * Either way the app no longer needs its own `vellum.d.ts`.
 *
 * The named types below are also exported, so app code that wants to annotate
 * a variable can `import type { VellumAppBridge } from "@vellumai/plugin-api/app"`.
 */

/**
 * A `sync_changed` invalidation forwarded from the host to a subscribed app.
 * The host scopes delivery to the tags the app asked for (reserved host
 * namespaces are never delivered), so `tags` lists only the matched tags.
 */
export interface VellumAppSyncEvent {
  type: "sync_changed";
  tags: string[];
}

/** Filter passed to {@link VellumAppBridge.subscribe}. */
export interface VellumAppSubscribeFilter {
  /** Sync tags the app wants to hear `sync_changed` invalidations for. */
  tags?: string[];
}

/**
 * Request init accepted by {@link VellumAppBridge.fetch}. A subset of the DOM
 * `RequestInit`: the bridge serializes the request across `postMessage`, so
 * `headers` must be a plain object and `body` a string (not a `Headers`
 * instance, `FormData`, or a stream).
 */
export interface VellumAppFetchInit {
  /** HTTP method. Defaults to `"GET"`. */
  method?: string;
  /** Request headers as a plain object. */
  headers?: Record<string, string>;
  /** Request body. Already-serialized string payloads only. */
  body?: string | null;
}

/**
 * Response returned by {@link VellumAppBridge.fetch}. A `fetch`-like subset,
 * not a full DOM `Response`: the body is delivered as text across the bridge,
 * so only `json()` and `text()` are available (no `blob()`, `body`, etc.).
 * Use {@link VellumAppBridge.asset} for binary payloads.
 */
export interface VellumAppFetchResponse {
  /** True when `status` is in the 2xx range. */
  ok: boolean;
  status: number;
  statusText: string;
  /** Response headers as a plain object. */
  headers: Record<string, string>;
  /** Parse the response body as JSON. */
  json(): Promise<unknown>;
  /** Read the response body as text. */
  text(): Promise<string>;
}

/**
 * The `window.vellum` bridge the host injects into a plugin app's sandboxed
 * iframe. Mirrors the runtime built by the assistant's `sandbox-bridge`.
 */
export interface VellumAppBridge {
  /**
   * The deep-link route the app was opened with, or `null` when opened
   * without one.
   */
  route: string | null;

  /**
   * Forward a surface action to the host chat (e.g. `"relay_prompt"` to send
   * a prompt into the conversation, `"set_view"` to change the app/chat
   * layout). Fire-and-forget — the host handles it out of band.
   */
  sendAction(actionId: string, data?: unknown): void;

  /**
   * Authenticated `fetch` to the app's own custom routes under `/v1/x/` (a
   * leading `/x/` is accepted and normalized). Proxied through the host so the
   * assistant's session/auth is attached — use this instead of the bare
   * global `fetch`, which fails from the sandboxed origin.
   */
  fetch(path: string, options?: VellumAppFetchInit): Promise<VellumAppFetchResponse>;

  /**
   * Resolve a bundled app asset to a `blob:` object URL the sandbox can load
   * in `<img>` / `<video>` / `<audio>`. The binary sibling of {@link fetch};
   * results are cached per path.
   */
  asset(path: string): Promise<string>;

  /**
   * Subscribe to host `sync_changed` invalidations matching `filter.tags` so
   * the app can refresh on demand instead of polling. Returns an unsubscribe
   * function.
   */
  subscribe(
    filter: VellumAppSubscribeFilter,
    callback: (event: VellumAppSyncEvent) => void,
  ): () => void;
}

declare global {
  interface Window {
    vellum: VellumAppBridge;
  }
}
