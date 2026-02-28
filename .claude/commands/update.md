# Update — Pull Latest and Restart Vellum

Pull the latest changes from main, restart the backend daemon, rebuild/launch the macOS app, and start the source gateway.

## Steps

0. Ensure Bun is on PATH:
   ```bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```

1. Kill app, daemon, and **all** gateway processes. There must only ever be one gateway running, and it must always be started from source:
   ```bash
   pkill -x "Vellum" || true
   pkill -x "vellum-assistant" || true
   vellum daemon stop || true
   pkill -f "dev:proxy" || true
   pkill -f "gateway/src/index" || true
   lsof -ti :7830 | xargs kill -9 2>/dev/null || true
   ```

2. Switch to main and pull latest:
   ```bash
   git checkout main
   git pull origin main
   ```

3. Install any new dependencies:
   ```bash
   cd assistant && bun install && cd ..
   cd gateway && bun install && cd ..
   ```

4. Start the daemon fresh with runtime HTTP enabled (required for gateway/Twilio/OAuth ingress):
   ```bash
   cd assistant && bun run daemon:restart:http && cd ..
   ```

5. Resolve gateway env and start the source gateway. These MUST run in the same shell so variables persist:
   ```bash
   INGRESS_PUBLIC_BASE_URL="$(
     python3 - <<'PY'
import json, os
cfg_path = os.path.expanduser("~/.vellum/workspace/config.json")
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    ingress = (cfg.get("ingress") or {}).get("publicBaseUrl") or ""
    print(str(ingress).strip())
except Exception:
    print("")
PY
   )"
   TWILIO_AUTH_TOKEN="${TWILIO_AUTH_TOKEN:-$(
     cd assistant
     bun -e 'import { getSecureKey } from "./src/security/secure-keys.js"; process.stdout.write(getSecureKey("credential:twilio:auth_token") ?? "")'
     cd ..
   )}"
   TWILIO_ACCOUNT_SID="${TWILIO_ACCOUNT_SID:-$(
     cd assistant
     bun -e 'import { getSecureKey } from "./src/security/secure-keys.js"; process.stdout.write(getSecureKey("credential:twilio:account_sid") ?? "")'
     cd ..
   )}"
   TWILIO_PHONE_NUMBER="${TWILIO_PHONE_NUMBER:-$(
     cd assistant
     bun -e 'import { getSecureKey } from "./src/security/secure-keys.js"; process.stdout.write(getSecureKey("credential:twilio:phone_number") ?? "")'
     cd ..
   )}"

   # Resolve default assistant ID from lockfile (prefer first valid entry).
   GATEWAY_DEFAULT_ASSISTANT_ID="${GATEWAY_DEFAULT_ASSISTANT_ID:-$(
     python3 - <<'PY'
import json, os
lock_path = os.path.expanduser("~/.vellum.lock.json")
try:
    with open(lock_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    for item in (data.get("assistants") or []):
        if isinstance(item, dict):
            aid = (item.get("assistantId") or "").strip()
            if aid:
                print(aid)
                break
except Exception:
    pass
PY
   )}"

   # Always default to "default" routing policy (matches CLI startGateway() behavior).
   GATEWAY_UNMAPPED_POLICY="${GATEWAY_UNMAPPED_POLICY:-default}"

   if [ "$GATEWAY_UNMAPPED_POLICY" = "default" ] && [ -z "$GATEWAY_DEFAULT_ASSISTANT_ID" ]; then
     echo "WARNING: GATEWAY_UNMAPPED_POLICY=default but no GATEWAY_DEFAULT_ASSISTANT_ID is set. Falling back to reject."
     GATEWAY_UNMAPPED_POLICY="reject"
   fi

   [ -z "$INGRESS_PUBLIC_BASE_URL" ] && echo "WARNING: INGRESS_PUBLIC_BASE_URL is empty (Twilio signature validation may fail)."
   [ -z "$TWILIO_AUTH_TOKEN" ] && echo "WARNING: TWILIO_AUTH_TOKEN is empty (Twilio webhooks will be rejected)."
   [ -z "$TWILIO_ACCOUNT_SID" ] && echo "WARNING: TWILIO_ACCOUNT_SID is empty (SMS delivery will fail)."
   [ -z "$TWILIO_PHONE_NUMBER" ] && echo "WARNING: TWILIO_PHONE_NUMBER is empty (SMS delivery will fail)."
   echo "Gateway routing: $GATEWAY_UNMAPPED_POLICY${GATEWAY_DEFAULT_ASSISTANT_ID:+ -> $GATEWAY_DEFAULT_ASSISTANT_ID}"

   # Start the source gateway (must be in the same shell block so env vars are available)
   cd gateway
   mkdir -p "${HOME}/.vellum"
   nohup env \
     GATEWAY_RUNTIME_PROXY_ENABLED=true \
     GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH=false \
     INGRESS_PUBLIC_BASE_URL="$INGRESS_PUBLIC_BASE_URL" \
     TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
     TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
     TWILIO_PHONE_NUMBER="$TWILIO_PHONE_NUMBER" \
     GATEWAY_UNMAPPED_POLICY="$GATEWAY_UNMAPPED_POLICY" \
     GATEWAY_DEFAULT_ASSISTANT_ID="$GATEWAY_DEFAULT_ASSISTANT_ID" \
     bun run dev:proxy \
     > "${HOME}/.vellum/gateway-dev.log" 2>&1 &
   cd ..
   ```

6. Poll gateway health with retries (fail fast before building the macOS app):
   ```bash
   # Poll gateway health with retries
   GATEWAY_HEALTHY=false
   for i in 1 2 3 4 5 6 7 8 9 10; do
     sleep 1
     if curl -sS --max-time 2 http://127.0.0.1:7830/healthz >/dev/null 2>&1; then
       GATEWAY_HEALTHY=true
       break
     fi
   done

   if [ "$GATEWAY_HEALTHY" != "true" ]; then
     echo ""
     echo "ERROR: Gateway failed to start or is not healthy after 10 seconds."
     echo "Recent gateway logs:"
     cat "${HOME}/.vellum/gateway-dev.log" 2>/dev/null || echo "(no log file found)"
     echo ""
     echo "Troubleshooting:"
     echo "  1. Check if port 7830 is in use: lsof -i :7830"
     echo "  2. Review full gateway log: cat ~/.vellum/gateway-dev.log"
     echo "  3. Try restarting: pkill -f 'gateway/src/index' && /update"
     echo ""
     echo "Stopping — please fix the issue before continuing."
     exit 1
   fi

   GATEWAY_PIDS=$(pgrep -f "gateway/src/index" 2>/dev/null | wc -l | tr -d ' ')
   if [ "$GATEWAY_PIDS" -gt 1 ]; then
     echo ""
     echo "ERROR: Multiple gateway processes detected ($GATEWAY_PIDS)."
     echo "PIDs:"
     pgrep -f "gateway/src/index" || true
     echo "Recent gateway logs:"
     tail -n 80 "${HOME}/.vellum/gateway-dev.log" 2>/dev/null || echo "(no log file found)"
     echo ""
     echo "Kill extras and retry:"
     echo "  pkill -f 'gateway/src/index' && /update"
     echo ""
     exit 1
   fi
   ```

7. Build the macOS app from source synchronously (wait for build to complete before launching to avoid opening a stale build), then launch with file-watching in the background:
   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh
   ```

   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh run &
   ```

8. Print startup summary (re-read values from gateway log since shell vars don't persist across steps):
   ```bash
   echo ""
   echo "=== Startup Summary ==="
   DAEMON_STATUS=$(curl -sS --max-time 2 http://127.0.0.1:7821/healthz 2>&1 || echo "UNHEALTHY")
   GATEWAY_STATUS=$(curl -sS --max-time 2 http://127.0.0.1:7830/healthz 2>&1 || echo "UNHEALTHY")
   echo "  Daemon:   $DAEMON_STATUS"
   echo "  Gateway:  $GATEWAY_STATUS"
   # Extract routing config from gateway startup log
   GATEWAY_POLICY=$(grep -o 'unmappedPolicy: "[^"]*"' ~/.vellum/gateway-dev.log 2>/dev/null | tail -1 || echo "unknown")
   GATEWAY_HAS_DEFAULT=$(grep -o 'hasDefaultAssistant: [a-z]*' ~/.vellum/gateway-dev.log 2>/dev/null | tail -1 || echo "unknown")
   echo "  Gateway routing: $GATEWAY_POLICY, $GATEWAY_HAS_DEFAULT"
   echo "  Gateway log: ~/.vellum/gateway-dev.log"
   echo "======================="
   echo ""
   ```

Report:

1. What was pulled (new commits).
2. The startup summary block output (daemon health, gateway health, env presence, routing config).
3. The gateway log path: `~/.vellum/gateway-dev.log`.
