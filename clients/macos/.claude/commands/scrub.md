# Scrub — Kill, Wipe, and Relaunch vellum-assistant

Kill the running vellum-assistant app, delete all persistent data so the next launch behaves like a first run (including onboarding), then start the daemon and rebuild/launch the app.

## Steps

1. Kill any running `vellum-assistant` processes:
   ```bash
   pkill -f "vellum-assistant"
   ```

2. Remove session logs and knowledge store:
   ```bash
   rm -rf ~/Library/Application\ Support/vellum-assistant/logs/
   rm -f ~/Library/Application\ Support/vellum-assistant/knowledge.json
   ```

3. Remove caches:
   ```bash
   rm -rf ~/Library/Caches/vellum-assistant/
   ```

4. Reset UserDefaults:
   ```bash
   defaults delete com.vellum.vellum-assistant
   ```

5. Confirm everything is clean by listing what remains (if anything) in `~/Library/Application Support/vellum-assistant/`.

6. Check if the daemon is already running:
   ```bash
   pgrep -f "src/index.ts daemon"
   ```
   If it's NOT running, start it in the background from the assistant repo:
   ```bash
   cd assistant && export PATH="$HOME/.bun/bin:$PATH" && bun run src/index.ts daemon start
   ```
   If it IS already running, skip this step and report that the daemon is already up.

7. Build and launch the macOS app:
   ```bash
   cd clients/macos && ./build.sh run
   ```
   Run this in the background so it doesn't block.

Report what was cleaned up and confirm both the daemon and app are running.
