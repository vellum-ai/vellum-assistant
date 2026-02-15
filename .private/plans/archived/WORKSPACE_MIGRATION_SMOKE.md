# Workspace Migration Smoke Test Runbook

Deterministic local smoke procedure for verifying the workspace migration
end-to-end. Target completion time: under 15 minutes.

## Prerequisites

- macOS with `bun` installed (`~/.bun/bin/bun`)
- The Vellum daemon is **not** currently running (`vellum daemon stop` or
  `kill $(cat ~/.vellum/vellum.pid)`)
- No existing `~/.vellum/workspace/` directory (back up and remove if present)

> **Safety**: This procedure creates and moves files inside `~/.vellum/`. If you
> have a live installation, back up the entire `~/.vellum/` tree first:
>
> ```bash
> cp -a ~/.vellum ~/.vellum.bak
> ```

---

## Step 1 — Seed old-style `~/.vellum` tree

Create the pre-migration (legacy flat) layout with sentinel content so we can
verify each file lands in the correct post-migration location.

```bash
# Ensure a clean slate
rm -rf ~/.vellum/workspace

# Root-level config
echo '{"provider":"anthropic","theme":"dark"}' > ~/.vellum/config.json

# data/ subtree (db, logs, sandbox/fs)
mkdir -p ~/.vellum/data/db
mkdir -p ~/.vellum/data/logs
mkdir -p ~/.vellum/data/sandbox/fs/project
echo "SENTINEL_DB"       > ~/.vellum/data/db/assistant.db
echo "SENTINEL_LOG"      > ~/.vellum/data/logs/vellum.log
echo "sandbox-hello"     > ~/.vellum/data/sandbox/fs/hello.txt
echo "project-main"      > ~/.vellum/data/sandbox/fs/project/main.ts

# hooks/
mkdir -p ~/.vellum/hooks
cat > ~/.vellum/hooks/smoke-test.sh << 'HOOK'
#!/bin/bash
echo "SMOKE_HOOK_RAN"
HOOK
chmod +x ~/.vellum/hooks/smoke-test.sh

# skills/
mkdir -p ~/.vellum/skills
echo '{"name":"smoke-skill","version":"1.0"}' > ~/.vellum/skills/smoke-skill.json

# Prompt files
echo "# Smoke Identity"  > ~/.vellum/IDENTITY.md
echo "# Smoke Soul"      > ~/.vellum/SOUL.md
echo "# Smoke User"      > ~/.vellum/USER.md
```

### Expected state after seeding

```
~/.vellum/
  config.json
  IDENTITY.md
  SOUL.md
  USER.md
  data/
    db/assistant.db
    logs/vellum.log
    sandbox/fs/
      hello.txt
      project/main.ts
  hooks/
    smoke-test.sh
  skills/
    smoke-skill.json
```

### Verify

```bash
ls ~/.vellum/config.json \
   ~/.vellum/IDENTITY.md \
   ~/.vellum/SOUL.md \
   ~/.vellum/USER.md \
   ~/.vellum/data/db/assistant.db \
   ~/.vellum/data/logs/vellum.log \
   ~/.vellum/data/sandbox/fs/hello.txt \
   ~/.vellum/data/sandbox/fs/project/main.ts \
   ~/.vellum/hooks/smoke-test.sh \
   ~/.vellum/skills/smoke-skill.json
```

All paths should resolve without errors.

### Failure triage

| Symptom | Cause | Fix |
|---|---|---|
| `No such file or directory` for any path | Seeding step missed or `~/.vellum` does not exist | Re-run the seeding commands; ensure `~/.vellum/` exists (`mkdir -p ~/.vellum`) |
| Permission denied | Restricted parent directory | Check permissions on `~/.vellum` (`chmod 755 ~/.vellum`) |

---

## Step 2 — Start the daemon

The daemon runs both `migrateToDataLayout()` and `migrateToWorkspaceLayout()`
on startup (see `assistant/src/daemon/lifecycle.ts:runDaemon`), then calls
`ensureDataDir()` to create any missing directories.

```bash
cd assistant && bun run src/index.ts daemon start
```

### Expected output

The daemon should start without errors. You should see the PID printed or a log
line indicating the daemon is listening on the socket.

### Verify daemon is running

```bash
cat ~/.vellum/vellum.pid  # Should print a valid PID
ls -la ~/.vellum/vellum.sock  # Should show a Unix socket file
```

### Failure triage

| Symptom | Cause | Fix |
|---|---|---|
| `Error: address already in use` | Another daemon is already running | Stop it: `kill $(cat ~/.vellum/vellum.pid)` then retry |
| `Error: ENOENT` on startup | Missing source files or `bun` not in PATH | Ensure you are in the `assistant/` directory and `bun` is available (`export PATH="$HOME/.bun/bin:$PATH"`) |
| Migration warnings in logs | Destination already exists (prior partial run) | Remove `~/.vellum/workspace` and restart from Step 1 |

---

## Step 3 — Verify moved paths (workspace layout)

After the daemon starts, the migration should have relocated all user-facing
state from `~/.vellum/` root into `~/.vellum/workspace/`.

### 3a. sandbox/fs extracted as workspace root

The contents of `~/.vellum/data/sandbox/fs/` should have been renamed to become
`~/.vellum/workspace/` itself. This means sandbox files now live at the
workspace root.

```bash
cat ~/.vellum/workspace/hello.txt
# Expected: sandbox-hello

cat ~/.vellum/workspace/project/main.ts
# Expected: project-main
```

The old `~/.vellum/data/sandbox/fs/` should no longer exist:

```bash
ls ~/.vellum/data/sandbox/fs 2>&1
# Expected: No such file or directory
```

### 3b. config.json

```bash
cat ~/.vellum/workspace/config.json
# Expected: {"provider":"anthropic","theme":"dark"}

ls ~/.vellum/config.json 2>&1
# Expected: No such file or directory  (moved into workspace)
```

### 3c. data/ directory

The entire `data/` subtree should have moved into the workspace:

```bash
cat ~/.vellum/workspace/data/db/assistant.db
# Expected: SENTINEL_DB

cat ~/.vellum/workspace/data/logs/vellum.log
# Expected: SENTINEL_LOG (may have additional daemon log lines appended)

ls ~/.vellum/data 2>&1
# Expected: No such file or directory  (moved into workspace)
```

### 3d. hooks/

```bash
cat ~/.vellum/workspace/hooks/smoke-test.sh
# Expected: #!/bin/bash\necho "SMOKE_HOOK_RAN"

ls ~/.vellum/hooks 2>&1
# Expected: No such file or directory  (moved into workspace)
```

### 3e. skills/

```bash
cat ~/.vellum/workspace/skills/smoke-skill.json
# Expected: {"name":"smoke-skill","version":"1.0"}

ls ~/.vellum/skills 2>&1
# Expected: No such file or directory  (moved into workspace)
```

### 3f. Prompt files (IDENTITY.md, SOUL.md, USER.md)

```bash
cat ~/.vellum/workspace/IDENTITY.md
# Expected: # Smoke Identity

cat ~/.vellum/workspace/SOUL.md
# Expected: # Smoke Soul

cat ~/.vellum/workspace/USER.md
# Expected: # Smoke User

ls ~/.vellum/IDENTITY.md ~/.vellum/SOUL.md ~/.vellum/USER.md 2>&1
# Expected: No such file or directory for each (moved into workspace)
```

### Failure triage

| Symptom | Cause | Fix |
|---|---|---|
| Files still at root (`~/.vellum/config.json` etc.) | Migration did not run or was skipped | Check daemon logs at `~/.vellum/workspace/data/logs/vellum.log` for warnings. Ensure `~/.vellum/workspace/` did not already exist before daemon start |
| `workspace/` exists but is empty | sandbox/fs extraction failed but workspace dir was created by `ensureDataDir()` | The migration is order-dependent: `ensureDataDir()` must run after `migrateToWorkspaceLayout()`. Check `lifecycle.ts` call order |
| Files at both root and workspace | Destination already existed (conflict), migration skipped the move | Remove conflicting destination files and re-run from Step 1 |

---

## Step 4 — Verify preserved root artifacts

Certain runtime files must remain at the `~/.vellum/` root level and should
**not** be moved into `workspace/`.

```bash
# Unix socket (used for IPC)
ls -la ~/.vellum/vellum.sock
# Expected: a socket file (type 's' in ls output)

# PID file
cat ~/.vellum/vellum.pid
# Expected: a numeric PID (e.g. 12345)

# Protected directory (trust rules, encrypted keys)
ls ~/.vellum/protected/
# Expected: directory exists (may contain trust.json, keys.enc, secret-allowlist.json)
```

### Failure triage

| Symptom | Cause | Fix |
|---|---|---|
| `vellum.sock` missing | Daemon did not start or crashed during startup | Check Step 2 output; look at daemon logs |
| `vellum.pid` missing | Daemon did not write PID file | Check daemon startup logs for errors |
| `protected/` missing | `ensureDataDir()` did not run | This is created by `ensureDataDir()` — verify it's called in `runDaemon()` |
| `vellum.sock` moved into `workspace/` | Bug in migration — runtime files are being relocated | Check `migrateToWorkspaceLayout()`: it should only move `config.json`, `data/`, `hooks/`, `IDENTITY.md`, `skills/`, `SOUL.md`, `USER.md` |

---

## Step 5 — Run `doctor`

The `doctor` command validates the full directory structure including the
workspace layout.

```bash
cd assistant && bun run src/index.ts doctor
```

### Expected output

All checks should pass. Key checks to look for:

```
Vellum Doctor

  Socket:    ~/.vellum/vellum.sock
  Autostart: enabled

  ✓ Bun is installed
  ✓ API key configured
  ✓ Daemon reachable
  ✓ Database exists and readable
  ✓ Directory structure exists        <-- THIS IS THE CRITICAL CHECK
  ✓ Disk space (XXXXmb free)
  ✓ Log file size (X.XMB)
  ✓ Database integrity check
```

The **Directory structure exists** check validates that all of these paths exist:
- `~/.vellum/` (root)
- `~/.vellum/workspace/` (workspace root)
- `~/.vellum/workspace/data/` (data dir)
- `~/.vellum/workspace/data/db/` (database dir)
- `~/.vellum/workspace/data/logs/` (logs dir)
- `~/.vellum/workspace/skills/` (skills dir)
- `~/.vellum/workspace/hooks/` (hooks dir)
- `~/.vellum/protected/` (protected dir at root)

### Failure triage

| Symptom | Cause | Fix |
|---|---|---|
| `✗ Directory structure exists — missing: ...` | Migration did not move some directories, or `ensureDataDir()` did not create them | Inspect the listed missing paths. Cross-reference with Step 3 results |
| `✗ Daemon reachable` | Daemon crashed after migration | Restart daemon and re-run doctor |
| `✗ Database exists and readable` | DB file sentinel content is not a valid SQLite database | This is expected if you used a sentinel string. The daemon should have created a real DB at `~/.vellum/workspace/data/db/assistant.db` during `initializeDb()`. If the sentinel file was moved first, the daemon may have failed to initialize. Check logs |

> **Note on the sentinel DB file**: The seeded `SENTINEL_DB` is not a real
> SQLite database. The migration will move it to
> `~/.vellum/workspace/data/db/assistant.db`, and then `initializeDb()` may fail
> or overwrite it. If the DB check fails, this is expected behavior for the smoke
> test. In a real migration, the original `assistant.db` is a valid SQLite file.
> To avoid this issue, you can skip seeding a fake DB file and let the daemon
> create a fresh one.

---

## Step 6 — Verify hooks, skills, prompt, and config read-write

### 6a. Config read-write

The config loader reads from `~/.vellum/workspace/config.json` (via
`getWorkspaceConfigPath()`).

```bash
# Read current config
cd assistant && bun run src/index.ts config get provider
# Expected: anthropic

# Write a config value
cd assistant && bun run src/index.ts config set theme light

# Verify write persisted to workspace path
cat ~/.vellum/workspace/config.json | grep -o '"theme":"light"'
# Expected: "theme":"light"

# Verify no config file leaked back to root
ls ~/.vellum/config.json 2>&1
# Expected: No such file or directory
```

### 6b. Skills loading

Skills are loaded from `~/.vellum/workspace/skills/` (via
`getWorkspaceSkillsDir()`).

```bash
# List loaded skills
cd assistant && bun run src/index.ts skills list 2>/dev/null || \
  ls ~/.vellum/workspace/skills/
# Expected: smoke-skill.json should be visible

# Verify the skill file is intact
cat ~/.vellum/workspace/skills/smoke-skill.json
# Expected: {"name":"smoke-skill","version":"1.0"}
```

### 6c. Hooks discovery and execution

Hooks are discovered from `~/.vellum/workspace/hooks/` (via
`getWorkspaceHooksDir()` which delegates to `getHooksDir()`).

```bash
# List hooks
cd assistant && bun run src/index.ts hooks list
# Expected: should show hooks from workspace/hooks/ directory

# Verify the smoke test hook file exists at workspace path
ls -la ~/.vellum/workspace/hooks/smoke-test.sh
# Expected: executable file present

# Verify no hooks remain at root
ls ~/.vellum/hooks 2>&1
# Expected: No such file or directory
```

> **Note**: Hook execution requires a hook manifest (`hook.json`) in a
> subdirectory format. The simple `smoke-test.sh` file seeded in Step 1 may not
> be picked up by the hooks system if it expects the structured
> `hooks/<name>/hook.json` + script layout. This is fine for verifying that the
> hooks **directory** was migrated. To test full hook execution, create a
> properly structured hook:
>
> ```bash
> mkdir -p ~/.vellum/workspace/hooks/smoke-hook
> cat > ~/.vellum/workspace/hooks/smoke-hook/hook.json << 'EOF'
> {
>   "name": "smoke-hook",
>   "event": "session:start",
>   "script": "run.sh",
>   "enabled": true
> }
> EOF
> cat > ~/.vellum/workspace/hooks/smoke-hook/run.sh << 'EOF'
> #!/bin/bash
> echo "SMOKE_HOOK_EXECUTED" >> /tmp/vellum-smoke-hook.log
> EOF
> chmod +x ~/.vellum/workspace/hooks/smoke-hook/run.sh
> ```
>
> Then start a new session and check `/tmp/vellum-smoke-hook.log`.

### 6d. Prompt files

Prompt files (`IDENTITY.md`, `SOUL.md`, `USER.md`) are read from workspace
paths via `getWorkspacePromptPath()`.

```bash
# Verify prompt files are readable from workspace
cat ~/.vellum/workspace/IDENTITY.md
# Expected: # Smoke Identity

cat ~/.vellum/workspace/SOUL.md
# Expected: # Smoke Soul

cat ~/.vellum/workspace/USER.md
# Expected: # Smoke User
```

### Failure triage

| Symptom | Cause | Fix |
|---|---|---|
| `config get` returns default instead of seeded value | Config loader is not reading from workspace path | Verify `getConfigPath()` in `config/loader.ts` calls `getWorkspaceConfigPath()` |
| `config set` writes to `~/.vellum/config.json` instead of workspace | Config writer is using legacy path | Check that `writeFileSync` target in the config module uses the workspace path |
| Skills not found | Skills loader using old `~/.vellum/skills/` path | Verify `getWorkspaceSkillsDir()` is used in `config/skills.ts` |
| Hooks not found after migration | Hooks directory not migrated or `getHooksDir()` points to old path | Verify `getHooksDir()` returns `getWorkspaceHooksDir()` in `util/platform.ts` |
| Prompt files show defaults, not seeded content | `ensurePromptFiles()` overwrote seeded files | `ensurePromptFiles()` should only create files if they don't exist; check its logic |

---

## Step 7 — Idempotency check

Restart the daemon to verify the migration is idempotent (second run is a
no-op).

```bash
# Stop the daemon
kill $(cat ~/.vellum/vellum.pid)
sleep 1

# Restart
cd assistant && bun run src/index.ts daemon start
```

### Verify

```bash
# All workspace files should be unchanged
cat ~/.vellum/workspace/config.json
# Expected: same content as after Step 6a

cat ~/.vellum/workspace/IDENTITY.md
# Expected: # Smoke Identity (or updated by ensurePromptFiles if it enriches)

# No files should have reappeared at root level
ls ~/.vellum/config.json 2>&1
# Expected: No such file or directory

ls ~/.vellum/data 2>&1
# Expected: No such file or directory

ls ~/.vellum/hooks 2>&1
# Expected: No such file or directory

ls ~/.vellum/skills 2>&1
# Expected: No such file or directory
```

### Failure triage

| Symptom | Cause | Fix |
|---|---|---|
| Files duplicated back to root | Migration is not idempotent — re-creating legacy files | Check that `migrateToWorkspaceLayout()` skips when source does not exist |
| Content overwritten in workspace | Second migration clobbered existing workspace files | Check that `migratePath()` skips when destination already exists |

---

## Cleanup

After the smoke test, restore your original installation:

```bash
# Stop the daemon
kill $(cat ~/.vellum/vellum.pid) 2>/dev/null

# Remove smoke test artifacts
rm -rf ~/.vellum

# Restore backup (if you made one)
mv ~/.vellum.bak ~/.vellum
```

---

## Summary checklist

| # | Check | Pass criteria |
|---|---|---|
| 1 | Legacy tree seeded | All 10 legacy paths exist |
| 2 | Daemon starts | PID file written, socket created |
| 3a | sandbox/fs extracted | `workspace/hello.txt` contains `sandbox-hello` |
| 3b | config.json moved | `workspace/config.json` exists, root `config.json` gone |
| 3c | data/ moved | `workspace/data/db/assistant.db` exists, root `data/` gone |
| 3d | hooks/ moved | `workspace/hooks/` exists, root `hooks/` gone |
| 3e | skills/ moved | `workspace/skills/` exists, root `skills/` gone |
| 3f | Prompt files moved | `workspace/IDENTITY.md`, `SOUL.md`, `USER.md` exist; root copies gone |
| 4 | Root artifacts preserved | `vellum.sock`, `vellum.pid`, `protected/` at root |
| 5 | `doctor` passes | Directory structure check shows all required paths |
| 6a | Config read-write | `config get`/`set` use workspace path |
| 6b | Skills loading | Skills found in `workspace/skills/` |
| 6c | Hooks discovery | Hooks found in `workspace/hooks/` |
| 6d | Prompt files readable | Prompt content matches seeded values |
| 7 | Idempotency | Second daemon start does not duplicate or clobber files |
