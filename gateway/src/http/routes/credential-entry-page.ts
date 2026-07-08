/**
 * Gateway-served one-time credential entry page.
 *
 * Velay-tunneled deployments have no SPA server behind the tunnel (Velay only
 * proxies allowlisted paths to the gateway, and the gateway serves no web
 * bundle), so the React entry page in `clients/web` is unreachable there.
 * This route serves a SELF-CONTAINED static page instead — inline CSS/JS, no
 * external assets — following the `oauth-callback.ts` static-page pattern.
 * nginx-fronted deployments never hit this route: nginx serves the SPA for
 * `/assistant/*` paths, so the React page wins there.
 *
 * SECURITY:
 * - The single-use token rides the URL FRAGMENT (`#token=`), which browsers
 *   never send over HTTP — this handler never sees it. The inline script
 *   reads it, strips it from history, and sends it only in POST bodies to
 *   the peek/submit routes (which validate it server-side).
 * - The page template is fully static: no request data is interpolated, and
 *   all dynamic content is rendered client-side via `textContent`.
 */

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Provide a credential</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #f5f5f7; color: #1a1f27;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #111318; color: #e8eaed; }
    .card { background: #1c1f26; border-color: #2c313a; }
    input[type="password"] { background: #111318; border-color: #3a404b; color: #e8eaed; }
    .muted { color: #9aa0aa; }
  }
  .card {
    width: 100%; max-width: 420px; background: #fff; border: 1px solid #e2e5ea;
    border-radius: 12px; padding: 28px; box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { font-size: 14px; line-height: 1.5; margin: 8px 0; }
  .muted { color: #5f6672; font-size: 13px; }
  .mono { font-family: Menlo, Consolas, monospace; font-size: 13px; }
  input[type="password"] {
    width: 100%; padding: 10px 12px; font-size: 14px; border: 1px solid #c9cedb;
    border-radius: 8px; margin: 10px 0 14px; background: #fff; color: inherit;
  }
  button {
    width: 100%; padding: 10px 12px; font-size: 14px; font-weight: 600;
    border: none; border-radius: 8px; background: #4453f2; color: #fff; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .error { color: #d64545; }
  .ok { color: #2e9e5b; }
  .hidden { display: none; }
</style>
</head>
<body>
<main class="card">
  <div id="loading"><h1>One-time credential link</h1><p class="muted">Checking this link…</p></div>

  <form id="form" class="hidden">
    <h1>Provide a credential</h1>
    <p>This one-time link securely collects <strong><span id="label"></span></strong> <span class="muted mono" id="slot"></span> for the assistant. The value goes straight into its encrypted vault — it is never shown in chat.</p>
    <p class="muted" id="expiry"></p>
    <input id="value" type="password" autocomplete="off" placeholder="Paste the value" required>
    <button id="submit" type="submit">Save credential</button>
    <p id="formError" class="error hidden"></p>
  </form>

  <div id="done" class="hidden"><h1 class="ok">Credential saved</h1><p>The value is stored in the assistant's encrypted vault. This link has now been used and can't be opened again — you can close this tab.</p></div>
  <div id="invalid" class="hidden"><h1 class="error">Invalid link</h1><p>This credential link isn't valid. Ask for a new one if a value still needs to be provided.</p></div>
  <div id="expired" class="hidden"><h1 class="error">Link expired</h1><p>This credential link has expired. Ask for a new one and use it within its validity window.</p></div>
  <div id="used" class="hidden"><h1 class="error">Link already used</h1><p>Each link works exactly once. Ask for a new one if the value still needs to be provided.</p></div>
  <div id="failed" class="hidden"><h1 class="error">Link no longer valid</h1><p>The assistant could not store the credential, and for safety this one-time link cannot be reused. Ask for a new link and try again there.</p></div>
</main>
<script>
(function () {
  "use strict";
  var MARKER = "/assistant/credentials/enter";
  var prefix = location.pathname.slice(0, location.pathname.indexOf(MARKER));

  var hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  var token = (hashParams.get("token") || "").trim();
  if (!token) {
    token = (new URLSearchParams(location.search).get("token") || "").trim();
  }
  // Strip the token from the address bar and this history entry immediately.
  history.replaceState(history.state, "", location.pathname);

  function show(id) {
    ["loading", "form", "done", "invalid", "expired", "used", "failed"].forEach(function (s) {
      document.getElementById(s).classList.toggle("hidden", s !== id);
    });
  }

  function outcomeFor(res, body) {
    if (res.status === 404 && body && body.error) {
      var code = body.error.code;
      if (code === "EXPIRED") return "expired";
      if (code === "USED") return "used";
      return "invalid";
    }
    if (res.status === 502) return "failed";
    return "invalid";
  }

  function post(path, payload) {
    return fetch(prefix + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { res: res, body: body };
      });
    });
  }

  if (!token) { show("invalid"); return; }

  post("/v1/credential-requests/peek", { token: token }).then(function (r) {
    if (!r.res.ok) { show(outcomeFor(r.res, r.body)); return; }
    var label = r.body.label || (r.body.service + ":" + r.body.field);
    document.getElementById("label").textContent = label;
    document.getElementById("slot").textContent = "(" + r.body.service + ":" + r.body.field + ")";
    if (r.body.expiresAt) {
      var mins = Math.max(1, Math.round((r.body.expiresAt - Date.now()) / 60000));
      document.getElementById("expiry").textContent =
        "Single-use \\u00b7 expires in about " + mins + " minute" + (mins === 1 ? "" : "s") + ".";
    }
    show("form");
  }).catch(function () { show("invalid"); });

  document.getElementById("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var value = document.getElementById("value").value;
    if (!value.trim()) return;
    var btn = document.getElementById("submit");
    var err = document.getElementById("formError");
    btn.disabled = true;
    err.classList.add("hidden");
    // The value is submitted verbatim — trimming only gates empty input.
    post("/v1/credential-requests/submit", { token: token, value: value }).then(function (r) {
      if (r.res.ok) { document.getElementById("value").value = ""; show("done"); return; }
      var outcome = outcomeFor(r.res, r.body);
      if (outcome === "failed") { show("failed"); return; }
      show(outcome);
    }).catch(function () {
      btn.disabled = false;
      err.textContent = "Something went wrong while submitting. Check your connection and try again.";
      err.classList.remove("hidden");
    });
  });
})();
</script>
</body>
</html>
`;

export function handleCredentialEntryPage(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }
  return new Response(PAGE_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
