---
name: "Self Upgrade"
description: "Upgrade velly to the latest version, restart the daemon, and restart the gateway"
user-invocable: true
metadata: {"vellum": {"emoji": "⬆️"}}
---

You are performing a self-upgrade of the Vellum assistant. Follow these steps **in order**. Use the `bash` tool to run each command. Confirm each step succeeds before moving to the next.

## Step 1: Install the latest velly

Run:

```bash
bun update -g @vellum-ai/velly
```

If `@vellum-ai/velly` was not installed globally via bun, try:

```bash
npm update -g @vellum-ai/velly
```

After updating, verify the new version:

```bash
vellum --version
```

Report the old and new version to the user.

## Step 2: Start a new daemon from the updated binary

Launch a fresh daemon process using the newly installed version. The new daemon will bind to the socket once the old one releases it.

```bash
vellum daemon start
```

## Step 3: Restart the gateway

If a gateway process is running, restart it so it picks up any protocol or dependency changes from the new version:

```bash
# Find the running gateway process
pgrep -f 'vellum-gateway|gateway/src/index.ts' || echo "No gateway process found"
```

If a gateway PID is found, send it SIGTERM so it drains gracefully:

```bash
pkill -TERM -f 'vellum-gateway|gateway/src/index.ts'
```

Then start the gateway again using whatever method the user's deployment uses (e.g. `bun run gateway/src/index.ts`, a systemd service, or a container orchestrator). If you are unsure how the gateway is deployed, ask the user.

## Step 4: Exit the current daemon

Stop the old daemon process so the new one takes over cleanly:

```bash
vellum daemon stop
```

Then start the new daemon:

```bash
vellum daemon start
```

Verify it is running:

```bash
vellum daemon status
```

## After Upgrade

Report back to the user with:
- The previous and new velly version
- Daemon status (running, PID)
- Gateway status (restarted or not found)
- Any errors encountered during the process
