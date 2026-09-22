/**
 * Ambient global types for the **app-side** Vellum bridge — `window.vellum`.
 *
 * A Vellum plugin app runs inside a sandboxed iframe, and the host injects a
 * `window.vellum` object into it at load time (see the assistant's
 * `sandbox-bridge` runtime). This file is the type-only counterpart to that
 * injection: it teaches TypeScript the shape of `window.vellum` so an app can
 * call `window.vellum.fetch(...)` without hand-declaring the global in every
 * project.
 *
 * Only `fetch` and `getContext` are typed for now: the surface the vast
 * majority of apps actually use, plus the host context an app needs to act on
 * the conversation the user is looking at. Other injected members are
 * intentionally left undeclared until there's a concrete need.
 *
 * A plugin app that depends on `@vellumai/plugin-api` pulls this in via a
 * one-line reference (recommended — no runtime import, which apps can't rely
 * on inside the sandbox):
 *
 * ```ts
 * /// <reference types="@vellumai/plugin-api/app" />
 * ```
 *
 * or by adding `"@vellumai/plugin-api/app"` to `compilerOptions.types` in
 * `tsconfig.json`. Either way the app no longer needs its own `vellum.d.ts`.
 *
 * The named types below are also exported, so app code that wants to annotate
 * a variable can `import type { VellumAppBridge } from "@vellumai/plugin-api/app"`.
 */

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
 * The host's current conversation selection, as returned by
 * {@link VellumAppBridge.getContext}.
 *
 * Both ids are `null` when the host has nothing selected on that axis, which
 * an app must handle: a conversation can be closed, and an app can be open
 * with no conversation beside it.
 */
export interface VellumAppContext {
  /**
   * The conversation the user currently has open, or `null` when none is.
   * This is the host's live navigation state, not a most-recently-used guess.
   */
  activeConversationId: string | null;
  /**
   * The conversation bound to the app in the side-by-side layout, or `null`
   * when the app is not open beside one.
   */
  editingConversationId: string | null;
}

/**
 * The `window.vellum` bridge the host injects into a plugin app's sandboxed
 * iframe. Mirrors the runtime built by the assistant's `sandbox-bridge`.
 */
export interface VellumAppBridge {
  /**
   * Authenticated `fetch` to the app's own custom routes under `/v1/x/` (a
   * leading `/x/` is accepted and normalized). Proxied through the host so the
   * assistant's session/auth is attached — use this instead of the bare
   * global `fetch`, which fails from the sandboxed origin.
   */
  fetch(
    path: string,
    options?: VellumAppFetchInit,
  ): Promise<VellumAppFetchResponse>;

  /**
   * Read the host's current conversation context.
   *
   * Read-only, and resolved when the call is made rather than when the app
   * mounted. The host's selection changes under a mounted app, so an app that
   * needs the current conversation must call this each time it acts instead
   * of caching the first answer.
   *
   * Knowing the conversation does not by itself grant the app anything on it:
   * what an app may do with an id is whatever the routes and actions it
   * already has allow.
   */
  getContext(): Promise<VellumAppContext>;
}

declare global {
  interface Window {
    vellum: VellumAppBridge;
  }
}
