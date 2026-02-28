# Update — Pull Latest and Restart Vellum

Pull the latest changes from main, rebuild/launch the macOS app (which manages its own daemon and gateway lifecycle).

## Steps

0. Ensure Bun is on PATH:
   ```bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```

1. Kill app, daemon, and **all** gateway processes. The macOS app manages its own daemon and gateway — kill everything so it starts clean:
   ```bash
   pkill -x "Vellum" || true
   pkill -x "vellum-assistant" || true
   vellum daemon stop || true
   pkill -f "dev:proxy" || true
   pkill -f "gateway/src/index" || true
   lsof -ti :7830 | xargs kill -9 2>/dev/null || true
   lsof -ti :7821 | xargs kill -9 2>/dev/null || true
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

4. Build the macOS app from source synchronously (wait for build to complete before launching to avoid opening a stale build), then launch with file-watching in the background:
   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh
   ```

   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh run &
   ```

5. Wait for the app to launch and settle, then print startup summary:
   ```bash
   sleep 5
   echo ""
   echo "=== Startup Summary ==="
   DAEMON_STATUS=$(curl -sS --max-time 2 http://127.0.0.1:7821/healthz 2>&1 || echo "NOT YET RUNNING (app will start daemon on first launch/hatch)")
   GATEWAY_STATUS=$(curl -sS --max-time 2 http://127.0.0.1:7830/healthz 2>&1 || echo "NOT YET RUNNING (app will start gateway on first launch/hatch)")
   echo "  Daemon:   $DAEMON_STATUS"
   echo "  Gateway:  $GATEWAY_STATUS"
   echo "======================="
   echo ""
   ```

Report:

1. What was pulled (new commits).
2. The startup summary block output (daemon health, gateway health).
3. Note: the macOS app manages its own daemon and gateway. On first launch, the app will hatch and start them automatically.
