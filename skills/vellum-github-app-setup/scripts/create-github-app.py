#!/usr/bin/env python3
"""
One-shot GitHub App creator via the manifest flow.

Starts a local HTTP server that:
1. Serves a page with a pre-filled manifest form pointing at GitHub
2. Catches the OAuth callback after the user clicks "Create" on GitHub
3. Exchanges the temporary code for app credentials (app_id, pem, client_secret, etc.)
4. Saves everything to a JSON file and exits

Usage:
    python3 create-github-app.py --org=ORG --name=NAME [options]

Then open http://localhost:PORT in your browser (auto-opened on macOS).

The user clicks "Go to GitHub", then clicks "Create GitHub App for ORG" — two clicks total.
"""

import http.server
import json
import urllib.request
import urllib.parse
import sys
import os
import argparse
import secrets
import html
import threading
import time
import socket

parser = argparse.ArgumentParser(description="Create a GitHub App via the manifest flow")
parser.add_argument("--org", required=True, help="GitHub org to create the app under (e.g. vellum-ai)")
parser.add_argument("--name", required=True, help="App name (e.g. Credence)")
parser.add_argument("--description", default="AI assistant bot", help="App description")
parser.add_argument("--url", default="https://github.com", help="Homepage URL for the app")
parser.add_argument("--port", type=int, default=29170, help="Local callback server port (default: 29170)")
parser.add_argument("--permissions", default="contents:write,pull_requests:write",
                    help="Comma-separated permission:level pairs (default: contents:write,pull_requests:write)")
parser.add_argument("--output", default="./github-app-credentials.json",
                    help="Where to save credentials JSON (default: ./github-app-credentials.json)")
parser.add_argument("--no-open", action="store_true", help="Don't auto-open the browser")
args = parser.parse_args()

PORT = args.port
STATE = secrets.token_hex(16)
CALLBACK = f"http://localhost:{PORT}/callback"

# Parse permissions
perms = {}
for p in args.permissions.split(","):
    key, val = p.strip().split(":")
    perms[key] = val

MANIFEST = {
    "name": args.name,
    "url": args.url,
    "description": args.description,
    "hook_attributes": {
        "url": f"{args.url}/webhook",
        "active": False
    },
    "redirect_url": CALLBACK,
    "public": False,
    "default_permissions": perms,
    "default_events": []
}

MANIFEST_JSON = json.dumps(MANIFEST, indent=2)
MANIFEST_JS = json.dumps(MANIFEST)

# Permission badges
perm_badges = "".join(
    f'<span class="badge">{k}: {v}</span>' for k, v in perms.items()
)

STYLE = """
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --accent: #238636;
  --accent-hover: #2ea043;
  --accent-text: #ffffff;
  --link: #58a6ff;
  --success-bg: #0d1117;
  --success-border: #238636;
  --error-bg: #0d1117;
  --error-border: #da3633;
  --code-bg: #1c2128;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.container {
  width: 100%;
  max-width: 520px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px;
}

.icon {
  width: 48px;
  height: 48px;
  background: var(--accent);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  font-size: 24px;
}

h1 {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 8px;
  letter-spacing: -0.01em;
}

.subtitle {
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 24px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-top: 1px solid var(--border);
  font-size: 14px;
}

.info-row:last-of-type {
  margin-bottom: 24px;
}

.info-label {
  color: var(--text-muted);
}

.info-value {
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace;
  font-size: 13px;
}

.badge {
  display: inline-block;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 12px;
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace;
  margin-left: 4px;
}

.btn {
  display: block;
  width: 100%;
  padding: 12px 20px;
  font-size: 15px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: center;
  text-decoration: none;
  transition: background 0.15s ease;
}

.btn-primary {
  background: var(--accent);
  color: var(--accent-text);
}

.btn-primary:hover {
  background: var(--accent-hover);
}

.footer {
  text-align: center;
  margin-top: 16px;
  font-size: 12px;
  color: var(--text-muted);
}

.footer a {
  color: var(--link);
  text-decoration: none;
}

.manifest-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

/* Success page */
.success-icon {
  width: 48px;
  height: 48px;
  background: var(--accent);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  font-size: 24px;
}

.detail-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  font-size: 14px;
  padding: 16px;
  background: var(--code-bg);
  border-radius: 8px;
  border: 1px solid var(--border);
  margin: 20px 0;
}

.detail-grid dt {
  color: var(--text-muted);
  white-space: nowrap;
}

.detail-grid dd {
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace;
  font-size: 13px;
  word-break: break-all;
}

.close-msg {
  color: var(--text-muted);
  font-size: 14px;
  margin-top: 20px;
}

/* Error page */
.error-icon {
  width: 48px;
  height: 48px;
  background: var(--error-border);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  font-size: 24px;
}

.error-detail {
  background: var(--code-bg);
  border: 1px solid var(--error-border);
  border-radius: 8px;
  padding: 16px;
  font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace;
  font-size: 13px;
  overflow-x: auto;
  margin-top: 16px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Loading state */
@keyframes spin {
  to { transform: rotate(360deg); }
}
.spinner {
  width: 20px; height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--accent-text);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  display: inline-block;
  vertical-align: middle;
  margin-right: 8px;
}
"""

FORM_PAGE = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create GitHub App</title>
<style>{STYLE}</style>
</head><body>
<div class="container">
  <div class="card">
    <div class="icon">🤖</div>
    <h1>Create GitHub App</h1>
    <p class="subtitle">
      This will register <strong>{html.escape(args.name)}</strong> as a GitHub App
      under the <strong>{html.escape(args.org)}</strong> organization.
    </p>

    <div class="info-row">
      <span class="info-label">Organization</span>
      <span class="info-value">{html.escape(args.org)}</span>
    </div>
    <div class="info-row">
      <span class="info-label">App name</span>
      <span class="info-value">{html.escape(args.name)}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Permissions</span>
      <span>{perm_badges}</span>
    </div>

    <form action="https://github.com/organizations/{html.escape(args.org)}/settings/apps/new?state={STATE}" method="post">
      <input type="text" name="manifest" id="manifest" class="manifest-input" readonly>
      <button type="submit" class="btn btn-primary" id="submit-btn">
        Continue to GitHub &rarr;
      </button>
    </form>
  </div>
  <p class="footer">
    Powered by <a href="https://agentskills.io">Agent Skills</a>
    &middot; Manifest flow &middot; Two clicks total
  </p>
</div>
<script>
document.getElementById("manifest").value = JSON.stringify({MANIFEST_JS});
document.querySelector("form").addEventListener("submit", function() {{
  document.getElementById("submit-btn").innerHTML =
    '<span class="spinner"></span>Redirecting to GitHub\u2026';
  document.getElementById("submit-btn").disabled = true;
}});
</script>
</body></html>"""


def success_page(name, app_id, slug, html_url, output_path):
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(name)} Created</title>
<style>{STYLE}</style>
</head><body>
<div class="container">
  <div class="card">
    <div class="success-icon">✓</div>
    <h1>{html.escape(name)} created</h1>
    <p class="subtitle">Your GitHub App is ready. The assistant will handle installation and configuration.</p>

    <dl class="detail-grid">
      <dt>App ID</dt>
      <dd>{html.escape(str(app_id))}</dd>
      <dt>Slug</dt>
      <dd>{html.escape(str(slug))}</dd>
      <dt>URL</dt>
      <dd><a href="{html.escape(html_url)}" style="color:var(--link);text-decoration:none">{html.escape(html_url)}</a></dd>
      <dt>Credentials</dt>
      <dd>{html.escape(output_path)}</dd>
    </dl>

    <p class="close-msg">You can close this tab.</p>
  </div>
</div>
</body></html>"""


def error_page(message):
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Error</title>
<style>{STYLE}</style>
</head><body>
<div class="container">
  <div class="card">
    <div class="error-icon">✕</div>
    <h1>Something went wrong</h1>
    <div class="error-detail">{html.escape(message)}</div>
  </div>
</div>
</body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/":
            self._respond(200, FORM_PAGE)

        elif parsed.path == "/callback":
            params = urllib.parse.parse_qs(parsed.query)
            code = params.get("code", [None])[0]
            state = params.get("state", [None])[0]

            if state != STATE:
                self._respond(400, error_page("State mismatch — this may be a CSRF attempt. Please try again."))
                return
            if not code:
                self._respond(400, error_page("No authorization code received from GitHub."))
                return

            try:
                url = f"https://api.github.com/app-manifests/{code}/conversions"
                req = urllib.request.Request(url, method="POST", data=b"",
                    headers={"Accept": "application/vnd.github+json"})
                resp = urllib.request.urlopen(req)
                data = json.loads(resp.read().decode())

                creds = {
                    "app_id": data["id"],
                    "app_slug": data.get("slug"),
                    "client_id": data.get("client_id"),
                    "client_secret": data.get("client_secret"),
                    "pem": data.get("pem"),
                    "webhook_secret": data.get("webhook_secret"),
                    "html_url": data.get("html_url"),
                    "owner": data.get("owner", {}).get("login"),
                }

                with open(args.output, "w") as f:
                    json.dump(creds, f, indent=2)

                self._respond(200, success_page(
                    name=args.name,
                    app_id=data["id"],
                    slug=data.get("slug", "unknown"),
                    html_url=data.get("html_url", ""),
                    output_path=os.path.abspath(args.output)
                ))

                print(f"\n✅ App created! ID: {data['id']}, Slug: {data.get('slug')}")
                print(f"   Credentials: {os.path.abspath(args.output)}")

                threading.Thread(target=lambda: (
                    time.sleep(1),
                    os._exit(0)
                ), daemon=True).start()

            except urllib.error.HTTPError as e:
                body = e.read().decode()
                self._respond(500, error_page(body))
                print(f"❌ Error: {body}", file=sys.stderr)
        else:
            self._respond(404, error_page("Page not found."))

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, format, *args):
        pass


def is_port_available(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


if __name__ == "__main__":
    if not is_port_available(PORT):
        print(f"❌ Port {PORT} is already in use. Try --port=DIFFERENT_PORT", file=sys.stderr)
        sys.exit(1)

    print(f"🌐 Open http://localhost:{PORT} in your browser")
    print(f"   Waiting for GitHub App creation...")

    if not args.no_open and sys.platform == "darwin":
        os.system(f"open http://localhost:{PORT}")

    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nCancelled")
        server.server_close()
