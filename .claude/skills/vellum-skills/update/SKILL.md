---
name: update
description: >
  Pull latest from main, use vellum ps/sleep/wake to manage daemon and gateway lifecycle, rebuild/launch the macOS app, and print a startup summary.
---

# Update — Pull Latest and Restart Vellum

Pull the latest changes from main, use `vellum` lifecycle CLI to stop and restart processes, rebuild/launch the macOS app.

## Steps

0. Ensure Bun is on PATH:
   ```bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```

1. Preflight snapshot — capture current state before making changes:
   ```bash
   vellum ps
   ```

2. Kill the macOS app first (it manages its own daemon/gateway, so it must be stopped before quiescing processes):
   ```bash
   pkill -x "Vellum" || true
   ```

3. Quiesce with `vellum sleep` — stop daemon and gateway processes. This is directory-agnostic and stops processes globally regardless of CWD:
   ```bash
   vellum sleep || true
   ```

   **Fallback only if sleep fails** (processes stubbornly remain):
   ```bash
   pkill -x "vellum-assistant" || true
   pkill -f "gateway/src/index" || true
   lsof -ti :7830 | xargs kill -9 2>/dev/null || true
   lsof -ti :7821 | xargs kill -9 2>/dev/null || true
   ```

4. Verify stopped — run `vellum ps` and confirm no running processes. If processes remain, log a warning:
   ```bash
   vellum ps
   ```

5. Switch to main and pull latest:
   ```bash
   git checkout main
   git pull origin main
   ```

6. Install any new dependencies:
   ```bash
   cd assistant && bun install && cd ..
   cd gateway && bun install && cd ..
   ```

7. Restart with `vellum wake` — start daemon and gateway from the current checkout. `vellum wake` must be run from the checkout directory that should supply the new daemon code:
   ```bash
   vellum wake
   ```

8. Build the macOS app from source synchronously (wait for build to complete before launching to avoid opening a stale build), then launch with file-watching in the background:
   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh
   ```

   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh run &
   ```

9. Verify fresh state — run `vellum ps` to confirm processes are running, then check health endpoints:
   ```bash
   sleep 5
   echo ""
   echo "=== Startup Summary ==="
   vellum ps
   echo ""
   DAEMON_STATUS=$(curl -sS --max-time 2 http://127.0.0.1:7821/healthz 2>&1 || echo "NOT YET RUNNING (app will start daemon on first launch/hatch)")
   GATEWAY_STATUS=$(curl -sS --max-time 2 http://127.0.0.1:7830/healthz 2>&1 || echo "NOT YET RUNNING (app will start gateway on first launch/hatch)")
   echo "  Daemon health:  $DAEMON_STATUS"
   echo "  Gateway health: $GATEWAY_STATUS"
   echo "======================="
   ```

Report:

1. What was pulled (new commits).
2. The startup summary block output (daemon health, gateway health).
3. Note: the macOS app manages its own daemon and gateway. On first launch, the app will hatch and start them automatically.
