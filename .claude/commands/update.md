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

5. Resolve gateway ingress and Twilio auth env from local config/credential store:
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
   TWILIO_AUTH_TOKEN="$(
     cd assistant
     bun -e 'import { getSecureKey } from "./src/security/secure-keys.js"; process.stdout.write(getSecureKey("credential:twilio:auth_token") ?? "")'
     cd ..
   )"
   if [ -z "$INGRESS_PUBLIC_BASE_URL" ]; then
     echo "WARNING: INGRESS_PUBLIC_BASE_URL is empty (Twilio signature validation may fail)."
   fi
   if [ -z "$TWILIO_AUTH_TOKEN" ]; then
     echo "WARNING: TWILIO_AUTH_TOKEN is empty (Twilio webhooks will be rejected)."
   fi
   ```

6. Start the source gateway first (so the app connects to this instance). Run in background with logs:
   ```bash
   cd gateway
   mkdir -p "${HOME}/.vellum"
   nohup env \
     GATEWAY_RUNTIME_PROXY_ENABLED=true \
     GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH=false \
     INGRESS_PUBLIC_BASE_URL="$INGRESS_PUBLIC_BASE_URL" \
     TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
     bun run dev:proxy \
     > "${HOME}/.vellum/gateway-dev.log" 2>&1 &
   cd ..
   ```

7. Build and launch the macOS app from source with gateway pinned to local `gateway/`:
   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh run &
   ```

8. Verify health:
   ```bash
   curl -sS http://127.0.0.1:7821/healthz
   curl -sS http://127.0.0.1:7830/healthz
   ```

Report:

1. What was pulled (new commits).
2. Daemon health and gateway health results.
3. Whether ingress and Twilio auth env were non-empty at startup.
4. The gateway log path: `~/.vellum/gateway-dev.log`.
