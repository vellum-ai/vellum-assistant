# Update — Pull Latest and Restart Vellum

Pull the latest changes from main, restart the backend daemon, rebuild/launch the macOS app, and start the source gateway.

## Steps

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

5. Build and launch the macOS app from source **and** start the source gateway. These can run in parallel. Pin gateway resolution to the repo `gateway/` directory so local gateway changes are used instead of a packaged fallback. Run both in the background since `build.sh run` enters a watch loop:
   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh run &
   ```

   ```bash
   cd gateway && bun run dev:proxy &
   ```

Report what was pulled (new commits), and confirm daemon, app, and source gateway are all running.
