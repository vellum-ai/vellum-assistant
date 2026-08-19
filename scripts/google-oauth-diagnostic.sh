#!/usr/bin/env bash
# Read-only Google OAuth diagnostic for a running assistant instance.
#
# Run this on the assistant (Doctor exec_command, `vellum ssh`, or a shell
# where `assistant` talks to that instance). It does not connect, disconnect,
# change oauth mode, reveal secrets, or print access tokens.
#
# Usage:
#   bash scripts/google-oauth-diagnostic.sh
#   bash /tmp/google-oauth-diagnostic.sh
#
# Paste the full stdout back. Do not disable or re-enable Google from this
# output.

set -u

GMAIL_READONLY="https://www.googleapis.com/auth/gmail.readonly"
GMAIL_MODIFY="https://www.googleapis.com/auth/gmail.modify"
GMAIL_SEND="https://www.googleapis.com/auth/gmail.send"
CAL_EVENTS="https://www.googleapis.com/auth/calendar.events"
GMAIL_PROFILE_URL="https://gmail.googleapis.com/gmail/v1/users/me/profile"
CAL_LIST_URL="https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1"
BODY_LIMIT=2000

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,14p' "$0"
  exit 0
fi

if ! command -v assistant >/dev/null 2>&1; then
  echo "assistant CLI not found on PATH." >&2
  echo "Run this on the assistant instance, not only the laptop Settings UI." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to parse and redact JSON." >&2
  exit 1
fi

redact() {
  python3 - <<'PY'
import json, re, sys

SECRET = re.compile(
    r"(token|secret|authorization|refresh|api[_-]?key|bearer|client_secret)",
    re.I,
)

def walk(x):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            out[k] = "***redacted***" if SECRET.search(str(k)) else walk(v)
        return out
    if isinstance(x, list):
        return [walk(i) for i in x]
    if isinstance(x, str) and (
        x.startswith("ya29.") or x.startswith("1//") or "Bearer " in x
    ):
        return "***redacted***"
    return x

raw = sys.stdin.read()
try:
    print(json.dumps(walk(json.loads(raw)), indent=2, sort_keys=True))
except Exception:
    print(raw)
PY
}

run_json() {
  local label="$1"
  shift
  echo "=== ${label} ==="
  local out rc=0
  out="$("$@" --json 2>&1)" || rc=$?
  printf '%s\n' "$out" | redact
  echo "{\"ok\": $([[ $rc -eq 0 ]] && echo true || echo false), \"exit\": $rc}"
  echo
}

run_text() {
  local label="$1"
  shift
  echo "=== ${label} ==="
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  printf '%s\n' "$out" | redact
  echo "{\"ok\": $([[ $rc -eq 0 ]] && echo true || echo false), \"exit\": $rc}"
  echo
}

echo "CAS-064 google oauth diagnostic $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "READ ONLY. Do not reconnect, disconnect, or change oauth mode from this output."
echo "assistant=$(command -v assistant)"
echo

run_json "platform_status" assistant platform status
run_json "credentials_status" assistant credentials status
run_json "oauth_mode_google" assistant oauth mode google
run_json "oauth_status_google" assistant oauth status google
run_json "oauth_providers_get_google" assistant oauth providers get google
run_json "credentials_list" assistant credentials list
run_json "watchers_list" assistant watchers list
run_text "config_google_oauth" assistant config get services.google-oauth

ACCOUNTS="$(
  python3 - <<'PY'
import json, subprocess

def load(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    text = (p.stdout or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        return {"_parseError": True, "_raw": text[:500]}

status = load(["assistant", "oauth", "status", "google", "--json"])
creds = load(["assistant", "credentials", "list", "--json"])
seen = []

def add(label, source, status_val, scopes, conn_id):
    if not label:
        return
    label = str(label)
    for row in seen:
        if row["account"] == label:
            return
    seen.append({
        "account": label,
        "source": source,
        "status": status_val,
        "scopes": scopes or [],
        "connectionId": conn_id,
    })

connections = []
if isinstance(status, dict):
    connections = status.get("connections") or []
elif isinstance(status, list):
    connections = status

for c in connections:
    if not isinstance(c, dict):
        continue
    add(
        c.get("account") or c.get("accountInfo") or c.get("account_label"),
        "oauth_status",
        c.get("status"),
        c.get("grantedScopes") or c.get("scopes_granted") or c.get("scopes"),
        c.get("id") or c.get("connectionId"),
    )

managed = []
local_creds = []
if isinstance(creds, dict):
    managed = creds.get("managedCredentials") or []
    local_creds = creds.get("credentials") or []
elif isinstance(creds, list):
    local_creds = creds

for c in managed:
    if not isinstance(c, dict):
        continue
    if str(c.get("provider") or "").lower() != "google":
        continue
    add(
        c.get("accountInfo") or c.get("account_label") or c.get("account"),
        "managed_catalog",
        c.get("status"),
        c.get("grantedScopes") or c.get("scopes_granted"),
        c.get("connectionId") or c.get("connection_id") or c.get("id"),
    )

for c in local_creds:
    if not isinstance(c, dict):
        continue
    svc = str(c.get("service") or "")
    account = c.get("oauthAccountInfo") or c.get("accountInfo") or c.get("alias")
    if "google" not in svc.lower() and not c.get("oauthStatus") and not c.get("oauthConnectionId"):
        continue
    add(
        account,
        "local_credential",
        c.get("oauthStatus") or c.get("status"),
        c.get("grantedScopes"),
        c.get("oauthConnectionId") or c.get("connectionId"),
    )

print(json.dumps(seen))
PY
)"

echo "=== derived_accounts ==="
printf '%s\n' "$ACCOUNTS" | python3 -m json.tool
echo

python3 - "$ACCOUNTS" "$GMAIL_READONLY" "$GMAIL_MODIFY" "$GMAIL_SEND" "$CAL_EVENTS" "$GMAIL_PROFILE_URL" "$CAL_LIST_URL" "$BODY_LIMIT" <<'PY'
import json, subprocess, sys

accounts = json.loads(sys.argv[1] or "[]")
gmail_ro, gmail_mod, gmail_send, cal = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
gmail_url, cal_url = sys.argv[6], sys.argv[7]
body_limit = int(sys.argv[8])

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    text = (p.stdout or "").strip()
    try:
        body = json.loads(text) if text else {}
    except Exception:
        body = {"raw": (p.stdout or "")[:body_limit], "stderr": (p.stderr or "")[:1000]}
    if isinstance(body, dict):
        payload = body.get("body")
        if isinstance(payload, str) and len(payload) > body_limit:
            body["body"] = payload[:body_limit] + "...[truncated]"
            body["bodyTruncated"] = True
        elif isinstance(payload, (dict, list)):
            encoded = json.dumps(payload)
            if len(encoded) > body_limit:
                body["body"] = encoded[:body_limit] + "...[truncated]"
                body["bodyTruncated"] = True
    err = (p.stderr or "").strip()
    if err:
        body = body if isinstance(body, dict) else {"body": body}
        body["stderr"] = err[:1000]
    return {"exit": p.returncode, "body": body}

def has(scopes, needle):
    return any(needle in str(s) for s in (scopes or []))

print("=== per_account_probes ===")
if not accounts:
    print(json.dumps({
        "warning": "no google accounts found in oauth status or credential catalog"
    }, indent=2))
    raise SystemExit(0)

results = []
for row in accounts:
    account = row.get("account")
    scopes = row.get("scopes") or []
    probe = {
        "account": account,
        "catalogStatus": row.get("status"),
        "connectionId": row.get("connectionId"),
        "source": row.get("source"),
        "hasGmailReadonly": has(scopes, gmail_ro),
        "hasGmailModify": has(scopes, gmail_mod),
        "hasGmailSend": has(scopes, gmail_send),
        "hasCalendarEvents": has(scopes, cal),
        "scopeCount": len(scopes),
        "scopes": scopes,
    }
    ping_cmd = ["assistant", "oauth", "ping", "google", "--json"]
    gmail_cmd = [
        "assistant", "oauth", "request", "--provider", "google",
        "-s", "--json", gmail_url,
    ]
    cal_cmd = [
        "assistant", "oauth", "request", "--provider", "google",
        "-s", "--json", cal_url,
    ]
    if account:
        ping_cmd = [
            "assistant", "oauth", "ping", "google",
            "--account", account, "--json",
        ]
        gmail_cmd = [
            "assistant", "oauth", "request", "--provider", "google",
            "--account", account, "-s", "--json", gmail_url,
        ]
        cal_cmd = [
            "assistant", "oauth", "request", "--provider", "google",
            "--account", account, "-s", "--json", cal_url,
        ]
    probe["ping"] = run(ping_cmd)
    probe["gmailProfile"] = run(gmail_cmd)
    probe["calendarList"] = run(cal_cmd)
    results.append(probe)

print(json.dumps(results, indent=2, sort_keys=True))
PY

echo
echo "=== interpretation_hints ==="
python3 - "$ACCOUNTS" <<'PY'
import json, sys

accounts = json.loads(sys.argv[1] or "[]")
print("Paste the full output. Quick read:")
print("- No accounts at all: reconnect never created an ACTIVE row (cause 1, Google consent likely blocked). Stop. Do not disable again.")
print("- Catalog/status ACTIVE but hasGmailReadonly false: cause 2, Calendar/identity-only reconnect. Gmail 403 expected.")
print("- ACTIVE + ping ok + gmailProfile HTTP 200: connection is fine; Luna/screenshot is elsewhere.")
print("- ACTIVE + ping 401/403 or gmail 403 with access_denied / insufficient scopes: token or scope problem (cause 2 or 4).")
print("- managed_catalog shows REVOKED/ERROR while oauth_status is empty: cause 3, ACTIVE-only filter hiding rows.")
print("Accounts seen:", [a.get("account") for a in accounts])
PY
