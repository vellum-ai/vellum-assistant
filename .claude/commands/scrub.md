# Scrub — Kill, Wipe, and Relaunch Vellum

Kill the running Vellum app, delete all persistent data so the next launch behaves like a first run (including onboarding), then start the daemon and rebuild/launch the app.

**Important:** Before scrubbing, make sure the Vellum mac app is fully quit (not just closed — right-click the dock icon and Quit, or use Cmd+Q). The app must not be running when TCC/Launch Services state is reset, otherwise macOS will re-cache stale data.

## Steps

1. Kill any running Vellum and daemon processes (including the legacy process name):
   ```bash
   pkill -x "Vellum" || true
   pkill -x "vellum-assistant" || true
   vellum daemon stop || true
   ```

2. Remove session logs and knowledge store:
   ```bash
   rm -rf ~/Library/Application\ Support/vellum-assistant/logs/
   rm -f ~/Library/Application\ Support/vellum-assistant/knowledge.json
   ```

3. Remove the daemon database (conversations, messages, etc.):
   ```bash
   rm -f ~/.vellum/data/assistant.db
   ```

4. Remove caches:
   ```bash
   rm -rf ~/Library/Caches/vellum-assistant/
   ```

5. Reset UserDefaults:
   ```bash
   defaults delete com.vellum.vellum-assistant
   ```

6. Confirm everything is clean by listing what remains (if anything) in `~/Library/Application Support/vellum-assistant/`.

7. Start the daemon fresh from the repo root:
   ```bash
   cd assistant && bun run src/index.ts daemon start && cd ..
   ```

8. Build and launch the macOS app (from the repo root):
   ```bash
   cd clients/macos && ./build.sh run
   ```
   Run this in the background so it doesn't block.

Report what was cleaned up and confirm both the daemon and app are running.
