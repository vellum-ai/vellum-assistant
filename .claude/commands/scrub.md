# Scrub — Kill, Wipe, and Relaunch Vellum

Kill the running Vellum app, delete all persistent data so the next launch behaves like a first run (including onboarding), then start the daemon and rebuild/launch the app.

**Important:** Before scrubbing, make sure the Vellum mac app is fully quit (not just closed — right-click the dock icon and Quit, or use Cmd+Q). The app must not be running when TCC/Launch Services state is reset, otherwise macOS will re-cache stale data.

## Steps

1. Kill any running Vellum, daemon, and Qdrant processes (including the legacy process name):
   ```bash
   pkill -x "Vellum" || true
   pkill -x "vellum-assistant" || true
   vellum daemon stop || true
   pkill -f qdrant || true
   ```

2. Remove session logs and knowledge store:
   ```bash
   rm -rf ~/Library/Application\ Support/vellum-assistant/logs/
   rm -f ~/Library/Application\ Support/vellum-assistant/knowledge.json
   ```

3. Remove the daemon database (conversations, messages, etc.), including legacy paths that the migration would otherwise re-populate:
   ```bash
   rm -f ~/.vellum/workspace/data/db/assistant.db ~/.vellum/workspace/data/db/assistant.db-shm ~/.vellum/workspace/data/db/assistant.db-wal
   rm -f ~/.vellum/workspace/data/assistant.db ~/.vellum/workspace/data/assistant.db-shm ~/.vellum/workspace/data/assistant.db-wal
   rm -f ~/.vellum/data/db/assistant.db ~/.vellum/data/db/assistant.db-shm ~/.vellum/data/db/assistant.db-wal
   rm -f ~/.vellum/data/assistant.db ~/.vellum/data/assistant.db-shm ~/.vellum/data/assistant.db-wal
   ```

4. Wipe the Qdrant vector memory store (long-term memories from previous sessions):
   ```bash
   rm -rf ~/.vellum/workspace/data/qdrant/collections/memory/
   ```

5. Remove caches:
   ```bash
   rm -rf ~/Library/Caches/vellum-assistant/
   ```

6. Reset UserDefaults:
   ```bash
   defaults delete com.vellum.vellum-assistant
   ```

7. Reset workspace prompt files to templates so the BOOTSTRAP.md onboarding ritual runs again:
   ```bash
   cp assistant/src/config/templates/IDENTITY.md ~/.vellum/workspace/IDENTITY.md
   cp assistant/src/config/templates/USER.md ~/.vellum/workspace/USER.md
   cp assistant/src/config/templates/SOUL.md ~/.vellum/workspace/SOUL.md
   cp assistant/src/config/templates/BOOTSTRAP.md ~/.vellum/workspace/BOOTSTRAP.md
   ```

8. Confirm everything is clean by listing what remains (if anything) in `~/Library/Application Support/vellum-assistant/`.

9. Start the daemon fresh from the repo root (in background):
   ```bash
   cd assistant && bun run src/index.ts daemon start > ~/.vellum/daemon-stdout.log 2>&1 &
   ```
   Wait a moment for the daemon to initialize:
   ```bash
   sleep 3
   ```

10. Build and launch the macOS app (from the repo root):
    ```bash
    cd clients/macos && ./build.sh run &
    ```

11. Wait for the app to launch and verify both processes are running:
    ```bash
    sleep 5
    ps aux | grep -E "(Vellum|bun.*daemon)" | grep -v grep
    ```

Report what was cleaned up and confirm both the daemon and app are running. The app should show the onboarding flow since all UserDefaults and data were reset.
