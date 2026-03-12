---
name: public-ingress
description: Set up and manage ngrok-based public ingress for webhooks and OAuth callbacks via ingress.publicBaseUrl
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🌍"
  vellum:
    display-name: "Public Ingress"
    user-invocable: true
---

You are setting up and managing a public ingress tunnel so that external services (Telegram webhooks, OAuth callbacks, etc.) can reach the local Vellum gateway. This skill uses ngrok to create a secure tunnel and persists the public URL as `ingress.publicBaseUrl`.

## Overview

The Vellum gateway listens locally and needs a publicly reachable URL for:

- Telegram webhook delivery
- Google/Slack OAuth redirect callbacks
- Any other inbound webhook traffic

This skill installs ngrok, configures authentication, starts a tunnel, discovers the public URL, and saves it to the assistant's ingress config.

## Step 1: Check Current Ingress Status

First, check whether ingress is already configured:

```bash
assistant config get ingress.publicBaseUrl
assistant config get ingress.enabled
```

Resolve the local gateway URL by running `assistant config get gateway.internalBaseUrl` (defaults to `http://127.0.0.1:7830`).

The commands return:

- `ingress.publicBaseUrl` — currently configured public ingress URL (if any)
- `ingress.enabled` — whether ingress is enabled

If `publicBaseUrl` is already set and the tunnel is running (check via `curl -s http://127.0.0.1:4040/api/tunnels`), tell the user the current status and ask if they want to reconfigure or if this is sufficient.

## Step 2: Install ngrok

Check if ngrok is installed:

```bash
ngrok version
```

If not installed, install it:

**macOS (Homebrew):**

```bash
brew install ngrok/ngrok/ngrok
```

**Linux (snap):**

```bash
sudo snap install ngrok
```

**Linux (apt — alternative):**

```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok
```

After installation, verify with `ngrok version`.

## Step 3: Authenticate ngrok

Check if ngrok already has an auth token configured:

```bash
ngrok config check
```

If not authenticated:

1. Tell the user: "You need an ngrok account to create tunnels. If you don't have one, sign up at https://dashboard.ngrok.com/signup — it's free."
2. Once they have an account, use `credential_store` to securely collect their auth token. **Never ask the user to paste the token directly in chat.**

   Use `credential_store` with:
   - action: `prompt`
   - service: `ngrok`
   - field: `authtoken`
   - label: `ngrok Auth Token`
   - description: `Get your auth token from https://dashboard.ngrok.com/get-started/your-authtoken`
   - usage_description: `ngrok authentication token for creating public tunnels`

3. Once the credential is stored, retrieve it via `credential_store` and apply it to ngrok:

   ```bash
   credential_store action=get service=ngrok field=authtoken
   ngrok config add-authtoken "<authtoken_from_credential_store>"
   ```

   If no value is returned, re-run `credential_store` with `action: "prompt"` and try again.

Verify authentication succeeded by checking `ngrok config check` again.

## Step 4: Start the Tunnel

Before starting, check for an existing ngrok process to avoid duplicates:

```bash
curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null
```

If a tunnel is already running, check whether it points to the correct local target. If so, skip to Step 5. If it points elsewhere, stop it first:

```bash
pkill -f ngrok || true
sleep 1
```

Resolve the local gateway URL first using `assistant config get gateway.internalBaseUrl`, then start ngrok in the background tunneling to that URL:

```bash
GATEWAY_URL=$(assistant config get gateway.internalBaseUrl)
nohup ngrok http "$GATEWAY_URL" --log=stdout > /tmp/ngrok.log 2>&1 &
echo $! > /tmp/ngrok.pid
```

Wait a few seconds for the tunnel to establish:

```bash
sleep 3
```

## Step 4b: Verify Port Alignment

Before discovering the public URL, verify that ngrok is forwarding to the same port the gateway is actually listening on. A mismatch here causes silent failures — webhooks appear to be delivered but never reach the gateway.

Query the ngrok tunnel's target port and the gateway's configured port, then compare them:

```bash
curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "
import sys, json, re

data = json.load(sys.stdin)
tunnels = data.get('tunnels', [])
if not tunnels:
    print('ERROR: no active ngrok tunnel found')
    sys.exit(1)

addr = tunnels[0].get('config', {}).get('addr', '')
match = re.search(r':(\d+)$', addr)
if not match:
    print(f'ERROR: could not extract port from ngrok tunnel addr: {addr}')
    sys.exit(1)

print(match.group(1))
"
```

```bash
assistant config get gateway.internalBaseUrl | grep -oE '[0-9]+$'
```

Compare the two port numbers. If they differ, warn the user:

> **Port mismatch detected:** ngrok is forwarding to port **X** but the gateway is listening on port **Y**. Webhooks will not reach the gateway. Stop ngrok (`pkill -f ngrok`), then re-run this skill to start ngrok on the correct port.

If the ports match, proceed silently to Step 5.

## Step 5: Discover the Public URL

Query the ngrok local API for the tunnel's public URL:

```bash
curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "
import sys, json
data = json.load(sys.stdin)
tunnels = data.get('tunnels', [])
for t in tunnels:
    url = t.get('public_url', '')
    if url.startswith('https://'):
        print(url)
        sys.exit(0)
for t in tunnels:
    url = t.get('public_url', '')
    if url:
        print(url)
        sys.exit(0)
print('ERROR: no tunnel found')
sys.exit(1)
"
```

If no tunnel is found, check `/tmp/ngrok.log` for errors and report them to the user.

## Step 6: Persist the Ingress Setting

Save the discovered public URL and enable ingress:

```bash
assistant config set ingress.publicBaseUrl "<public-url>"
assistant config set ingress.enabled true
```

Verify it was saved:

```bash
assistant config get ingress.publicBaseUrl
assistant config get ingress.enabled
```

## Step 7: Report Completion

Summarize the setup:

- **Public URL:** `<the-url>` (this is your `ingress.publicBaseUrl`)
- **Local gateway target:** (the URL from `assistant config get gateway.internalBaseUrl`)
- **ngrok dashboard:** http://127.0.0.1:4040

Provide useful follow-up commands:

- **Check tunnel status:** `curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "import sys,json; [print(t['public_url']) for t in json.load(sys.stdin)['tunnels']]"`
- **View ngrok logs:** `cat /tmp/ngrok.log`
- **Restart tunnel:** `pkill -f ngrok; sleep 1; GATEWAY_URL=$(assistant config get gateway.internalBaseUrl); nohup ngrok http "$GATEWAY_URL" --log=stdout > /tmp/ngrok.log 2>&1 &`
- **Stop tunnel:** `pkill -f ngrok`
- **Rotate URL:** Stop and restart ngrok (free tier assigns a new URL each time; update `ingress.publicBaseUrl` afterward)

**Important:** On ngrok's free tier, the public URL changes every time the tunnel restarts. After restarting, re-run this skill or manually update `ingress.publicBaseUrl` and any registered webhooks (e.g., Telegram).

## Troubleshooting

### ngrok not installed

Run the install commands in Step 2. On macOS, make sure Homebrew is installed first (`brew --version`).

### Auth token invalid or expired

Sign in to https://dashboard.ngrok.com, copy a fresh token from the "Your Authtoken" page, and re-run Step 3.

### ngrok API (port 4040) not responding

The ngrok process may not be running. Check with `ps aux | grep ngrok`. If not running, start it per Step 4. If running but 4040 is unresponsive, check `/tmp/ngrok.log` for errors.

### Gateway not reachable on local target

Re-check the local gateway target with `assistant config get gateway.internalBaseUrl`. Run `curl -s "$(assistant config get gateway.internalBaseUrl)/healthz"` to verify it is reachable. If the gateway is not running, start the assistant first.

### "Too many connections" or tunnel limit errors

ngrok's free tier allows one tunnel at a time. Stop any other ngrok tunnels before starting a new one.

### ngrok port doesn't match gateway port

**Symptom:** Webhooks return connection refused or timeouts even though both ngrok and the gateway appear to be running.

**Cause:** ngrok is forwarding to a different port than the gateway is listening on. This can happen if the gateway port was changed after ngrok was started, or if ngrok was started manually with a hardcoded port.

**Fix:** Stop ngrok (`pkill -f ngrok`), verify the gateway URL with `assistant config get gateway.internalBaseUrl`, then re-run this skill to start ngrok on the correct port.

### ngrok automatically restarts with wrong port

If after killing the ngrok process, it automatically re-spawns and is still attached to the incorrect port, check to see if there is a launch agent process configured to auto-restart it. This might exist at `~/Library/LaunchAgents/com.ngrok.tunnel.plist`. If so, it needs to be either removed or updated.
