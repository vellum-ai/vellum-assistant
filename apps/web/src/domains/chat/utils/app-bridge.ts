// ---------------------------------------------------------------------------
// Shared bridge utilities for app iframes
// ---------------------------------------------------------------------------

/** Fetch proxy path validation (matches desktop ATL-83 restriction). */
export const FETCH_PROXY_ALLOWED_PATH_RE = /^\/v1\/x\//;

/**
 * Safely serialize a value for embedding inside an inline `<script>` block.
 * `JSON.stringify` alone doesn't escape `</script>` or `<!--`, which can break
 * out of the script context in `srcdoc`. We replace the two dangerous sequences
 * after stringifying.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
}

/**
 * Build the JS bridge script that is injected into app iframes.
 *
 * The bridge provides:
 * - In-memory localStorage / sessionStorage polyfills (sandbox blocks real storage)
 * - `window.vellum.sendAction(actionId, data)` for surface actions
 * - `window.vellum.fetch(path, options)` for authenticated fetch proxying
 * - `window.vellum.route` — deep-link route from the parent URL hash (or null)
 */
export function buildBridgeScript(appId: string, route?: string): string {
  return `<script>
(function() {
  // In-memory storage polyfill for sandboxed iframe
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

  // Vellum JS bridge
  window.vellum = {
    route: ${jsonForScript(route ?? null)},
    sendAction: function(actionId, data) {
      window.parent.postMessage({
        type: 'vellum_surface_action',
        appId: ${jsonForScript(appId)},
        actionId: actionId,
        data: data || {}
      }, '*');
    }
  };

  // Authenticated fetch bridge
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
        appId: ${jsonForScript(appId)},
        callId: callId,
        path: path,
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        body: options.body || null
      }, '*');
    });
  };
})();
</script>`;
}

/**
 * Inject the bridge script into app HTML.
 *
 * Tries `</body>` first, then falls back to after `</head>`, and finally
 * prepends if neither tag is found.
 *
 * Uses `lastIndexOf` (not `String.replace`) so that a literal closing-tag
 * sequence embedded inside a `<script>` block — e.g. inside a JS string or
 * comment — can't hijack the inject site. The real document-level close tag
 * is the last occurrence; hijacking that requires inserting tag text *after*
 * the body closes, which would itself be a broken document.
 *
 * Broke the Twitter Monitor app on 2026-05-11 when a JS comment mentioned
 * the closing-body tag literally. The first-match `replace` injected the
 * bridge mid-script, and the `</script>` in the bridge terminated the host
 * script tag, spilling its remaining contents into the body as text.
 */
export function injectBridge(html: string, appId: string, route?: string): string {
  const bridge = buildBridgeScript(appId, route);
  const BODY_CLOSE = "</body>";
  const HEAD_CLOSE = "</head>";

  const bodyIdx = html.lastIndexOf(BODY_CLOSE);
  if (bodyIdx !== -1) {
    return html.slice(0, bodyIdx) + bridge + html.slice(bodyIdx);
  }
  const headIdx = html.lastIndexOf(HEAD_CLOSE);
  if (headIdx !== -1) {
    const after = headIdx + HEAD_CLOSE.length;
    return html.slice(0, after) + bridge + html.slice(after);
  }
  return bridge + html;
}
