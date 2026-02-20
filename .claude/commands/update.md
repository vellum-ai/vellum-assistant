# Update — Pull Latest and Restart Vellum

Pull the latest changes from main, restart the backend daemon, and rebuild/launch the macOS app.

## Steps

1. Kill app + daemon processes only (do **not** kill a manually run source gateway):
   ```bash
   pkill -x "Vellum" || true
   pkill -x "vellum-assistant" || true
   vellum daemon stop || true
   ```

   If a source gateway is already running (for example `cd gateway && bun run dev:proxy`), leave it running.

2. Switch to main and pull latest:
   ```bash
   git checkout main
   git pull origin main
   ```

3. Install any new dependencies:
   ```bash
   cd assistant && bun install && cd ..
   ```

4. Start the daemon fresh:
   ```bash
   cd assistant && bun run src/index.ts daemon start && cd ..
   ```

5. Build and launch the macOS app from source. Pin gateway resolution to the repo `gateway/` directory so local gateway changes are used instead of a packaged fallback. Run this in the background since `build.sh run` enters a watch loop:
   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh run &
   ```

6. If no gateway is running yet and you need ingress/webhook testing, start gateway from source in a separate terminal:
   ```bash
   cd gateway && bun run dev:proxy
   ```

Report what was pulled (new commits), whether an existing source gateway was preserved or started, and confirm daemon + app are running.
