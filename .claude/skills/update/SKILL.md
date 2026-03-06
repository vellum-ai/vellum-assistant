---
name: update
description: >
  Pull latest from main (or a specified branch), use vellum ps/sleep/wake to manage assistant and gateway lifecycle, rebuild/launch the macOS app, and print a startup summary.
---

# Update — Pull Latest and Restart Vellum

Pull the latest changes from main (or a specified branch), use `vellum` lifecycle CLI to stop and restart processes, rebuild/launch the macOS app.

The user may pass `$ARGUMENTS` as the branch name (e.g., `/update feature/phone-setup`). If provided, check out and pull that branch instead of `main`. If not provided, default to `main`.

## Steps

0. Ensure Bun is on PATH:
   ```bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```

1. Preflight snapshot — capture current state before making changes:
   ```bash
   vellum ps
   ```

2. Kill the macOS app and any stale file-watcher processes first (old `build.sh run` watchers will detect git-pulled Swift changes and bounce the app repeatedly):
   ```bash
   pkill -x "Vellum" || true
   pkill -f "build\.sh run" || true
   ```

3. Quiesce with `vellum sleep` — stop assistant and gateway processes. This is directory-agnostic and stops processes globally regardless of CWD:
   ```bash
   vellum sleep || true
   ```

4. Verify stopped — run `vellum ps` and confirm no running processes. If `vellum ps` shows processes still running, run fallback cleanup to force-kill them:
   ```bash
   vellum ps
   ```

   **Fallback cleanup if `vellum ps` confirms processes are still running:**
   ```bash
   pkill -x "vellum-assistant" || true
   pkill -f "gateway/src/index" || true
   lsof -ti :7830 | xargs kill -9 2>/dev/null || true
   lsof -ti :7821 | xargs kill -9 2>/dev/null || true
   ```
   After fallback cleanup, run `vellum ps` again to confirm all processes are stopped.

5. Determine the target branch and switch to it:

   ```bash
   BRANCH="${ARGUMENTS:-main}"
   git fetch origin "$BRANCH"
   git checkout "$BRANCH"
   git pull origin "$BRANCH"
   ```

6. Install any new dependencies:
   ```bash
   cd assistant && bun install && cd ..
   cd gateway && bun install && cd ..
   ```

7. Restart with `vellum wake` — start assistant and gateway from the current checkout. `vellum wake` must be run from the checkout directory that should supply the new assistant code:
   ```bash
   vellum wake
   ```

8. Build the macOS app (foreground, so compilation errors are caught immediately):
   ```bash
   REPO_ROOT="$(pwd)"
   cd clients/macos && VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh
   ```

   If the build fails, stop and report the error. Do not proceed to launch.

   Then launch with file-watching in the background (the build is cached, so this just launches + watches):
   ```bash
   VELLUM_GATEWAY_DIR="$REPO_ROOT/gateway" ./build.sh run &
   ```

9. Verify fresh state — run `vellum ps` to confirm processes are running:
   ```bash
   sleep 5
   echo ""
   echo "=== Startup Summary ==="
   vellum ps
   echo "======================="
   ```

Report:

1. What was pulled (new commits).
2. The startup summary block output (assistant health, gateway health).
3. Whether the macOS app build succeeded or failed (and the error if it failed).
4. Note: the macOS app manages its own assistant and gateway. On first launch, the app will hatch and start them automatically.
