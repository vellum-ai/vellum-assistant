# Update — Pull Latest and Restart Vellum

Pull the latest changes from main, restart the backend daemon, and rebuild/launch the macOS app.

## Steps

1. Kill any running Vellum and daemon processes:
   ```bash
   pkill -x "Vellum" || true
   pkill -x "vellum-assistant" || true
   vellum daemon stop || true
   ```

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

5. Build and launch the macOS app. Run this in the background since `build.sh run` enters a watch loop:
   ```bash
   cd clients/macos && ./build.sh run &
   ```

Report what was pulled (new commits) and confirm both the daemon and app are running.
