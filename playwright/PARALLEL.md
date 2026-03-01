# Running Playwright Tests in Parallel (4 Workers)

This document analyzes the constraints around running our Playwright agent tests
with `workers: 4` and proposes solutions for each.

---

## Current Architecture

Each test case in `cases/` is a markdown file that gets picked up by
`cases.spec.ts` and executed by an Anthropic agent loop. The agent interacts
with:

1. **A native macOS desktop app** via AppleScript / System Events
2. **A Playwright browser page** for web-based tool calls
3. **macOS `screencapture`** for screen recording and screenshots
4. **Temp files on disk** for passing scripts to `osascript`

The standalone `runner.ts` and the `install.spec.ts` test also share some of
these resources.

---

## Constraint Analysis

### 1. Hardcoded Temp File Paths (FIXED)

| File | Path | Risk |
|------|------|------|
| `applescript.ts` | `/tmp/pw-agent-applescript.scpt` | Concurrent workers overwrite each other's scripts mid-execution |
| `type-env-var.ts` | `/tmp/pw-agent-type-env-var.scpt` | Same — secret-typing script gets clobbered |

**Resolution (this PR):** Both paths now include the Playwright `workerIndex`
suffix (e.g. `/tmp/pw-agent-applescript-w0.scpt`,
`/tmp/pw-agent-applescript-w1.scpt`). The `workerIndex` flows from
`testInfo.workerIndex` → `AgentOptions` → `ToolContext` → each tool.

### 2. Desktop App Singleton (BLOCKING for desktop-app tests)

The macOS app is a single-instance process:

- **`launch_app.ts`** calls `open -a "…/Vellum.app"` — macOS will activate the
  existing instance rather than launching a second one.
- **`fixtures.ts`** clears `defaults delete com.vellum.vellum-assistant` — a
  global UserDefaults domain shared by all instances.
- **Teardown** sends `tell application "Vellum" to quit` — this kills the one
  running instance, even if another worker still needs it.
- **AppleScript** targets UI elements via `tell process "Vellum"` — if only one
  instance is running, multiple agents would be clicking the same buttons.

**Impact:** Any two desktop-app fixture tests running simultaneously will
interfere with each other. This is the single biggest blocker for full
parallelism.

**Proposed solutions (ranked by effort):**

| Approach | Effort | Description |
|----------|--------|-------------|
| **A. Serial mode for desktop tests** | Low | Use `test.describe.configure({ mode: "serial" })` or set `PW_WORKERS=1` in CI. Non-desktop tests still parallelize. |
| **B. CI sharding across runners** | Medium | Use `--shard=1/4 … --shard=4/4` to split tests across 4 separate macOS runners. Each gets its own display, app instance, and filesystem. No code changes needed, but 4× runner cost. |
| **C. Per-worker app copies** | High | At build time (or in CI), create N copies of the `.app` bundle with distinct `CFBundleIdentifier` values (`com.vellum.vellum-assistant-w0`, `-w1`, …). Each worker launches its own copy. Requires changes to the build script and fixture setup. |
| **D. Launch argument for isolation** | High | Modify the Swift app to accept a `--defaults-domain` or `--data-dir` launch argument. Each worker passes a unique value. Requires Swift code changes but avoids rebuilding multiple bundles. |

### 3. Screen Recording Conflicts (BLOCKING for concurrent desktop tests)

`screencapture -V 600 -x` captures the **entire macOS display**. If two workers
start screen recordings concurrently:

- They may interfere with each other (only one `screencapture -V` can run at a
  time on some macOS versions).
- Even if both run, they capture the same screen — the recordings would show
  overlapping UI interactions from different tests, making them useless for
  debugging.

**Proposed solutions:**

| Approach | Effort | Description |
|----------|--------|-------------|
| **A. Accept shared recording** | None | Let the single recording capture all activity. Acceptable for CI debugging since agent trace logs are the primary diagnostic. |
| **B. Disable recording in parallel** | Low | Skip `screencapture` when `workers > 1`. The Playwright browser video (`video: "on"`) still records the browser page per-test. |
| **C. CI sharding** | Medium | Each shard gets its own display — recordings are naturally isolated. |

### 4. AppleScript UI Targeting (BLOCKING for concurrent desktop tests)

AppleScript targets the app by process name:

```applescript
tell application "System Events"
  tell process "Vellum"
    click button "Start" of window 1
  end tell
end tell
```

If multiple tests control the same process, they'll race on UI state — one test
clicks "Start" while another expects to see the API key input.

**This is inherently tied to constraint #2.** Solving the app singleton problem
(per-worker copies or sharding) also solves AppleScript targeting, since each
worker would target a differently-named process.

### 5. UserDefaults / Data Directory Conflicts (BLOCKING for concurrent desktop tests)

- `com.vellum.vellum-assistant` UserDefaults domain is global.
- `~/.config/vellum/` (or `~/.vellum/`) data directory is shared.
- The `install.spec.ts` test modifies `~/.config/vellum/` via `install.sh`.

**Resolution (this PR, partial):** `fixtures.ts` now computes a worker-specific
defaults domain (`com.vellum.vellum-assistant-w1`, etc.) for the `defaults
delete` call. However, the **app itself** still reads from its compiled bundle
identifier, so this only isolates fixture setup/teardown — the app's runtime
storage is not yet isolated. Full isolation requires approach C or D from
constraint #2.

### 6. Browser / Port Congestion (NOT A BLOCKER)

Playwright natively handles browser isolation: each worker gets its own browser
process on a unique debug port. No changes needed.

### 7. Anthropic API Rate Limits (POTENTIAL BOTTLENECK)

With 4 workers running agent loops concurrently, API request volume quadruples.
The agent already handles 429/529/503 with exponential backoff (`agent.ts`
lines 152-163), so this should degrade gracefully rather than fail. However,
test wall-clock time may not improve linearly if rate-limited.

---

## Recommendation

### Phase 1: Immediate wins (this PR)

1. **Set `workers: 4`** in `playwright.config.ts` (configurable via
   `PW_WORKERS` env var).
2. **Fix temp file isolation** — worker-indexed paths for AppleScript/env-var
   scripts.
3. **Thread `workerIndex`** through the entire tool chain so future tools can
   use it.
4. **Worker-aware fixture setup** — `setupFixture` now accepts `workerIndex`.

These changes are **safe for the current test suite** because:

- `install.spec.ts` is a single test (no parallelism within one test).
- `cases.spec.ts` generates multiple tests, but with `fullyParallel: false`
  Playwright distributes them across workers round-robin. Since there are
  currently only 5 case files (and 1 is experimental), only a few tests will
  run concurrently.
- **However**, if multiple desktop-app fixture tests run at the same time,
  they will still conflict (constraint #2). In practice, CI should set
  `PW_WORKERS=1` until the desktop app isolation is solved, or accept the
  risk with the small test count.

### Phase 2: CI sharding (recommended next step)

Use Playwright's built-in `--shard` flag to split tests across multiple macOS
runners:

```yaml
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: bun run test -- --shard=${{ matrix.shard }}/4
```

This gives each shard its own:
- macOS display (screen recording isolation)
- App instance (singleton is fine — only one test uses it per runner)
- Filesystem (no temp file or data directory conflicts)

Cost: ~4× runner minutes, but wall-clock time drops by ~4×.

### Phase 3: Per-worker app copies (if sharding cost is too high)

Build N copies of the `.app` bundle with unique `CFBundleIdentifier` and display
names:

```bash
for i in 0 1 2 3; do
  cp -R "dist/Vellum.app" "dist/Vellum-w${i}.app"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.vellum.assistant-w${i}" \
    "dist/Vellum-w${i}.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Vellum-w${i}" \
    "dist/Vellum-w${i}.app/Contents/Info.plist"
done
```

Then each worker launches `Vellum-w{workerIndex}.app`, targets
`process "Vellum-w{workerIndex}"` in AppleScript, and uses a unique defaults
domain. This enables true single-runner parallelism but requires build script
and fixture changes.

---

## Environment Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PW_WORKERS` | `4` | Number of Playwright parallel workers |

---

## Files Changed in This PR

| File | Change |
|------|--------|
| `playwright.config.ts` | Added `workers` (default 4, configurable via `PW_WORKERS`) and `fullyParallel: false` |
| `agent/tools/types.ts` | Added `workerIndex` to `ToolContext` |
| `agent/tools/index.ts` | `executeTool` now accepts and passes `workerIndex` |
| `agent/tools/applescript.ts` | Temp script path includes worker index |
| `agent/tools/type-env-var.ts` | Temp script path includes worker index |
| `agent/agent.ts` | `AgentOptions` accepts `workerIndex`, forwards to `executeTool` |
| `agent/fixtures.ts` | `setupFixture` accepts `workerIndex`, uses worker-specific defaults domain |
| `agent/runner.ts` | Passes `workerIndex: 0` explicitly (standalone runner is single-threaded) |
| `tests/cases.spec.ts` | Passes `testInfo.workerIndex` to both `setupFixture` and `runAgent` |
