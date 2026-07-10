/**
 * Sandboxed iframe bridge utilities.
 *
 * Provides everything needed to safely render untrusted HTML inside
 * `<iframe sandbox="allow-scripts">` (no `allow-same-origin`):
 *
 * 1. **Storage polyfill** — in-memory shim for `localStorage` / `sessionStorage`,
 *    which throw `SecurityError` in sandboxed contexts without `allow-same-origin`.
 * 2. **Action bridge** — `window.vellum.sendAction()` forwards surface actions to
 *    the parent via `postMessage`.
 * 3. **Fetch proxy** — `window.vellum.fetch()` proxies authenticated requests
 *    through the parent, keeping auth tokens out of the sandbox.
 * 4. **Link interceptor** — catches clicks on `<a>` elements and opens them in
 *    new tabs via `window.open()`, which the `allow-popups` sandbox token
 *    permits. Without this, links inside sandboxed iframes are non-interactive
 *    because the sandbox lacks `allow-top-navigation` (intentionally, for
 *    security — the interceptor is the safer alternative).
 * 5. **Safe injection** — `injectScript()` inserts `<script>` tags using
 *    `lastIndexOf` to avoid hijacking when app JS contains literal close-tag
 *    sequences.
 *
 * All sandboxed iframes that render untrusted HTML must use these utilities.
 * The storage polyfill is required even for non-interactive preview iframes.
 * The link interceptor is injected by `injectBridge` (interactive iframes only).
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox
 * @see https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path pattern allowed through the fetch proxy (matches desktop ATL-83 restriction). */
export const FETCH_PROXY_PATH_RE = /^\/v1\/x\//;

// ---------------------------------------------------------------------------
// Script serialization
// ---------------------------------------------------------------------------

/**
 * Safely serialize a value for embedding inside an inline `<script>` block.
 *
 * `JSON.stringify` alone doesn't escape `</script>` or `<!--`, which can
 * break out of the script context in `srcdoc`. We replace the two dangerous
 * sequences after stringifying.
 *
 * @see https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
}

// ---------------------------------------------------------------------------
// Storage polyfill
// ---------------------------------------------------------------------------

/**
 * Build a `<script>` tag that replaces `localStorage` and `sessionStorage`
 * with in-memory shims.
 *
 * Required for every sandboxed iframe without `allow-same-origin`. Without
 * this, any code that accesses `window.localStorage` — including framework
 * initialization in React, Vue, i18next, etc. — throws a `SecurityError`
 * and prevents the app from mounting.
 */
export function buildStoragePolyfill(): string {
  return `<script>
(function() {
  var store = {};
  var storageShim = {
    getItem: function(k) { return store.hasOwnProperty(k) ? store[k] : null; },
    setItem: function(k, v) { store[k] = String(v); },
    removeItem: function(k) { delete store[k]; },
    clear: function() { store = {}; },
    get length() { return Object.keys(store).length; },
    key: function(i) { return Object.keys(store)[i] || null; }
  };
  try {
    Object.defineProperty(window, 'localStorage', { value: storageShim, writable: true, configurable: true });
  } catch(e) { window.localStorage = storageShim; }
  try {
    Object.defineProperty(window, 'sessionStorage', { value: storageShim, writable: true, configurable: true });
  } catch(e) { window.sessionStorage = storageShim; }
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Link interceptor
// ---------------------------------------------------------------------------

/**
 * Build a `<script>` tag that intercepts clicks on `<a>` elements inside the
 * sandboxed iframe and opens them in new tabs.
 *
 * Sandboxed iframes without `allow-top-navigation` cannot navigate the parent
 * window, so plain `<a href="...">` links are silently non-interactive. Adding
 * `allow-top-navigation` would let untrusted app JS redirect the host page at
 * will. Instead, this interceptor uses event delegation to catch link clicks
 * and calls `window.open()` (permitted by the existing `allow-popups` token),
 * which opens the URL in a new tab with `noopener,noreferrer`.
 *
 * The listener is registered in the **bubble** phase (not capture) and bails
 * out early if `e.defaultPrevented` is already true. This lets sandboxed app
 * click handlers run first — if they call `preventDefault()` (e.g. to handle a
 * link via their own router or post-message bridge), the interceptor defers.
 * `stopPropagation()` is intentionally not called so app handlers that listen
 * on ancestor nodes still see the event.
 *
 * Scheme detection uses the **raw** `href` attribute, not the resolved
 * `el.href` property. In `srcdoc` documents the browser resolves relative and
 * fragment links (e.g. `#section`, `./page`) against the embedding page's
 * URL, so `el.href` becomes an absolute `http(s)` URL that would be
 * incorrectly intercepted. Checking the raw attribute preserves the original
 * scheme, leaving fragments and relative links to in-frame navigation.
 *
 * Only external links (http:, https:, mailto:, tel:) are intercepted. Anchor
 * links (`#foo`), relative paths, and `javascript:` URIs are left alone — the
 * former are in-page navigation, the latter are already blocked by the sandbox.
 */
export function buildLinkInterceptorScript(): string {
  return `<script>
(function() {
    document.addEventListener('click', function(e) {
      // Bubble phase: let app handlers run first. If they already handled
      // the click (preventDefault), defer to them.
      if (e.defaultPrevented) return;
      var el = e.target;
      while (el && el !== document.body) {
        if (el.tagName === 'A' && el.getAttribute('href')) {
          // Use the raw href attribute for scheme detection. In srcdoc
          // documents el.href resolves fragment/relative links against the
          // embedding page URL, producing absolute http(s) URLs that would
          // be wrongly intercepted. The raw attribute preserves the scheme.
          var rawHref = el.getAttribute('href');
          if (/^https?:|^mailto:|^tel:/i.test(rawHref)) {
            e.preventDefault();
            window.open(rawHref, '_blank', 'noopener,noreferrer');
            return;
          }
        }
        el = el.parentElement;
      }
    }, false);
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Full bridge script
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** Include the authenticated fetch proxy bridge. Default: false. */
  fetch?: boolean;
  /** Deep-link route exposed as `window.vellum.route`. */
  route?: string;
}

/**
 * Build the bridge logic script (action sender, fetch proxy, `window.vellum`
 * namespace) WITHOUT the storage polyfill.
 *
 * This is injected at the end of the document via `injectScript`. The
 * storage polyfill is prepended separately via `prependScript` so that it
 * runs before any app code that accesses `localStorage` during parsing.
 */
function buildBridgeLogicScript(frameId: string, options?: BridgeOptions): string {
  const enableFetch = options?.fetch ?? false;
  const route = options?.route ?? null;

  const fetchBridge = enableFetch
    ? `
  window.vellum._pendingFetches = {};
  window.vellum._fetchNextId = 1;
  window.vellum._resolveFetch = function(callId, status, statusText, body, headers) {
    var p = window.vellum._pendingFetches[callId];
    if (!p) return;
    delete window.vellum._pendingFetches[callId];
    p.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      statusText: statusText,
      headers: headers || {},
      _body: body,
      json: function() { return Promise.resolve(JSON.parse(body)); },
      text: function() { return Promise.resolve(body); }
    });
  };
  window.vellum._rejectFetch = function(callId, errorMessage) {
    var p = window.vellum._pendingFetches[callId];
    if (!p) return;
    delete window.vellum._pendingFetches[callId];
    p.reject(new Error(errorMessage));
  };
  window.addEventListener('message', function(event) {
    var d = event.data;
    if (!d) return;
    if (d.type === 'vellum_fetch_response' && d.callId) {
      if (d.error) {
        window.vellum._rejectFetch(d.callId, d.error);
      } else {
        window.vellum._resolveFetch(d.callId, d.status, d.statusText, d.body, d.headers);
      }
    }
  });
  window.vellum.fetch = function(path, options) {
    options = options || {};
    return new Promise(function(resolve, reject) {
      var callId = 'f' + (window.vellum._fetchNextId++);
      window.vellum._pendingFetches[callId] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        type: 'vellum_fetch_request',
        frameId: ${jsonForScript(frameId)},
        callId: callId,
        path: path,
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        body: options.body || null
      }, '*');
    });
  };`
    : "";

  return `<script>
(function() {
  window.vellum = {
    route: ${jsonForScript(route)},
    sendAction: function(actionId, data) {
      window.parent.postMessage({
        type: 'vellum_surface_action',
        frameId: ${jsonForScript(frameId)},
        actionId: actionId,
        data: data || {}
      }, '*');
    }
  };${fetchBridge}
})();
</script>`;
}

/**
 * Build the complete bridge script (polyfill + logic) as a single string.
 *
 * Useful for tests that want to inspect the full output. In production,
 * `injectBridge` is preferred because it places the polyfill and bridge
 * logic at separate positions in the HTML.
 */
export function buildBridgeScript(frameId: string, options?: BridgeOptions): string {
  return buildStoragePolyfill() + buildBridgeLogicScript(frameId, options) + buildLinkInterceptorScript();
}

// ---------------------------------------------------------------------------
// HTML injection
// ---------------------------------------------------------------------------

/**
 * Safely inject a script string into HTML at the end of the document.
 *
 * Insertion priority: before the last `</body>`, then after the last
 * `</head>`, then prepended. Uses `lastIndexOf` so that literal close-tag
 * sequences inside `<script>` blocks (comments, strings) can't hijack the
 * injection site.
 */
export function injectScript(html: string, script: string): string {
  const BODY_CLOSE = "</body>";
  const HEAD_CLOSE = "</head>";

  const bodyIdx = html.lastIndexOf(BODY_CLOSE);
  if (bodyIdx !== -1) {
    return html.slice(0, bodyIdx) + script + html.slice(bodyIdx);
  }
  const headIdx = html.lastIndexOf(HEAD_CLOSE);
  if (headIdx !== -1) {
    const after = headIdx + HEAD_CLOSE.length;
    return html.slice(0, after) + script + html.slice(after);
  }
  return script + html;
}

const HEAD_OPEN_RE = /<head(\s[^>]*)?>/i;
const HTML_OPEN_RE = /<html(\s[^>]*)?>/i;

/**
 * Prepend a script to the beginning of an HTML document so it executes
 * before any other scripts during HTML parsing.
 *
 * Insertion priority: right after `<head>`, then after `<html>`, then
 * prepended to the raw string. This ensures the script runs before any
 * inline `<script>` tags in the body.
 */
export function prependScript(html: string, script: string): string {
  const headMatch = HEAD_OPEN_RE.exec(html);
  if (headMatch) {
    const after = headMatch.index + headMatch[0].length;
    return html.slice(0, after) + script + html.slice(after);
  }
  const htmlMatch = HTML_OPEN_RE.exec(html);
  if (htmlMatch) {
    const after = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, after) + script + html.slice(after);
  }
  return script + html;
}

/**
 * Inject the full bridge into app HTML.
 *
 * The storage polyfill is prepended (runs before any app scripts) while
 * the bridge logic is appended before `</body>` (app code calls
 * `window.vellum` APIs asynchronously after mount, not during parsing).
 */
export function injectBridge(html: string, frameId: string, options?: BridgeOptions): string {
  return prependScript(
    injectScript(html, buildBridgeLogicScript(frameId, options) + buildLinkInterceptorScript()),
    buildStoragePolyfill(),
  );
}

/**
 * Prepare HTML for a non-interactive preview iframe.
 *
 * Prepends the storage polyfill so it executes before any inline app
 * scripts that might access `localStorage` during parsing. Also hides
 * scrollbars for the thumbnail viewport.
 */
export function preparePreviewHtml(html: string): string {
  const HIDE_SCROLLBARS =
    "<style>html,body{overflow:hidden!important;scrollbar-width:none!important;}::-webkit-scrollbar{display:none!important;}</style>";
  return prependScript(html, buildStoragePolyfill() + HIDE_SCROLLBARS);
}
