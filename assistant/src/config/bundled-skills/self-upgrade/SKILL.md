---
name: "Self Upgrade"
description: "Upgrade vellum to the latest version, restart the daemon, and restart the gateway"
user-invocable: true
metadata: {"vellum": {"emoji": "⬆️"}}
---

You are performing a self-upgrade of the Vellum assistant. Follow these steps **in order**. Use the `bash` tool to run each command. Confirm each step succeeds before moving to the next.

## Step 1: Record the current version

```bash
vellum --version
```

Save this value to report later.

## Step 2: Install the latest vellum

```bash
bun update -g vellum
```

If `vellum` was not installed globally via bun, try:

```bash
npm update -g vellum
```

After updating, verify the new version:

```bash
vellum --version
```

## Step 3: Restart the gateway

If a gateway process is running, restart it so it picks up any protocol or dependency changes from the new version:

```bash
pgrep -f 'vellum-gateway|gateway/src/index.ts' || echo "No gateway process found"
```

If a gateway PID is found, send it SIGTERM so it drains gracefully:

```bash
pkill -TERM -f 'vellum-gateway|gateway/src/index.ts'
```

Then start the gateway again using whatever method the user's deployment uses (e.g. `bun run gateway/src/index.ts`, a systemd service, or a container orchestrator). If you are unsure how the gateway is deployed, ask the user.

## Step 4: Restart the daemon

Use `vellum daemon restart` which stops the old daemon and starts a new one from the updated binary in a single command:

```bash
vellum daemon restart
```

Verify it is running:

```bash
vellum daemon status
```

**Important:** This is the last step because the current daemon process is the one executing this conversation. After the restart, the new daemon takes over and this session ends gracefully.

## After Upgrade

Report back to the user with:
- The previous and new vellum version
- Daemon status (running, PID)
- Gateway status (restarted or not found)
- Any errors encountered during the process
