---
name: "Public Ingress"
description: "Set up and manage ngrok-based public ingress for webhooks and OAuth callbacks via ingress.publicBaseUrl"
user-invocable: true
metadata: {"vellum": {"emoji": "🌍"}}
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
vellum config get ingress.publicBaseUrl
```

Also determine the local gateway target. The gateway listens on `http://127.0.0.1:${GATEWAY_PORT:-7830}` by default.

If `ingress.publicBaseUrl` is already set and the tunnel is running (check via `curl -s http://127.0.0.1:4040/api/tunnels`), tell the user the current status and ask if they want to reconfigure or if this is sufficient.

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
2. Once they have an account, ask them to paste their auth token directly in chat. They can find it at https://dashboard.ngrok.com/get-started/your-authtoken.

3. Once the user provides the token, configure ngrok with it immediately:
```bash
ngrok config add-authtoken <token>
```

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

Start ngrok in the background, tunneling to the local gateway:

```bash
nohup ngrok http http://127.0.0.1:${GATEWAY_PORT:-7830} --log=stdout > /tmp/ngrok.log 2>&1 &
echo $! > /tmp/ngrok.pid
```

Wait a few seconds for the tunnel to establish:

```bash
sleep 3
```

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
vellum config set ingress.publicBaseUrl "<public-url>"
vellum config set ingress.enabled true
```

Verify it was saved:

```bash
vellum config get ingress.publicBaseUrl
vellum config get ingress.enabled
```

## Step 7: Report Completion

Summarize the setup:

- **Public URL:** `<the-url>` (this is your `ingress.publicBaseUrl`)
- **Local gateway:** `http://127.0.0.1:${GATEWAY_PORT:-7830}`
- **ngrok dashboard:** http://127.0.0.1:4040

Provide useful follow-up commands:

- **Check tunnel status:** `curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "import sys,json; [print(t['public_url']) for t in json.load(sys.stdin)['tunnels']]"`
- **View ngrok logs:** `cat /tmp/ngrok.log`
- **Restart tunnel:** `pkill -f ngrok; sleep 1; nohup ngrok http http://127.0.0.1:${GATEWAY_PORT:-7830} --log=stdout > /tmp/ngrok.log 2>&1 &`
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
Ensure the Vellum gateway is running on `http://127.0.0.1:${GATEWAY_PORT:-7830}`. Check with `curl -s http://127.0.0.1:${GATEWAY_PORT:-7830}/health`. If not running, start the assistant daemon first.

### "Too many connections" or tunnel limit errors
ngrok's free tier allows one tunnel at a time. Stop any other ngrok tunnels before starting a new one.
