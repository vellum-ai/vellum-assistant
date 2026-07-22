# Your self-hosted assistant on your phone

Reach a self-hosted Vellum assistant from your phone with no dependency on
hosted Vellum. Everything runs on your own machine; your phone connects
straight to it over an HTTPS address you control, and a QR code pairs the
device in a single scan.

This is a CLI-driven flow for people who already run their assistant locally
(`vellum wake`). If you use the managed Vellum Cloud app, you don't need any
of this — sign in and your phone is already connected.

## How it works

```
phone (Safari / installed PWA)
   │  HTTPS
   ▼
Tailscale front  (https://your-assistant.ts.net)
   │
   ▼
nginx edge  (127.0.0.1:7840)  ──►  serves the web app
   │                               proxies /v1 to the gateway
   ▼
gateway ──► assistant
```

The nginx edge is the single public surface: it serves the web app and
forwards API traffic to the gateway. An HTTPS front (Tailscale by default)
terminates TLS and makes the edge reachable from your phone.

## Before you start

- The `vellum` CLI installed, with an assistant hatched and awake
  (`vellum wake`). Every command below talks to the running assistant.
- **nginx** installed:
  - macOS: `brew install nginx`
  - Linux: `sudo apt install nginx`
- **Tailscale** installed on both the host machine and your phone, both
  signed into the same tailnet. (Only needed for the default private path —
  see [Step 4](#4-put-an-https-address-in-front) for public alternatives.)

## 1. Enable remote web ingress

Remote web access is gated behind a feature flag. Turn it on for your
assistant:

```bash
vellum flags set web-remote-ingress true
```

## 2. Build the web app in self-hosted mode

The nginx edge serves a build of the web app compiled for self-hosting
(pointed at your own gateway, not Vellum Cloud):

```bash
cd clients/web && VITE_PLATFORM_MODE=false bun run build
```

> Prefer a prebuilt bundle? Installing the `@vellumai/web` package makes its
> packaged `dist/` available, and the nginx edge will find it automatically —
> no local build required.

## 3. Start the nginx edge

```bash
vellum nginx-ingress up
```

This serves the web app on `http://127.0.0.1:7840` and proxies `/v1` to the
gateway. Useful companions:

```bash
vellum nginx-ingress status   # is it running, and where
vellum nginx-ingress down     # stop the edge
```

The listen port defaults to `7840`; override it with the
`VELLUM_NGINX_INGRESS_PORT` environment variable if it clashes with
something else.

## 4. Put an HTTPS address in front

Your phone needs an HTTPS URL that reaches the nginx edge. The default path
keeps the assistant private to your own devices via Tailscale.

```bash
vellum tunnel --provider tailscale
```

While the nginx edge is running, the tunnel automatically targets it and
records the public URL in your workspace config (`ingress.publicBaseUrl`), so
channel integrations (Telegram, Twilio, …) can reach the assistant too. Note
the `https://…ts.net` address it prints — you'll pass it to the pairing step.

<details>
<summary>Manual Tailscale fallback (no <code>vellum tunnel</code> needed)</summary>

Tailscale can serve the edge directly. This works on any recent Tailscale
install:

```bash
tailscale serve --bg 7840
tailscale serve status   # prints your https://<host>.<tailnet>.ts.net URL
```

That URL fronts the nginx edge over your tailnet with automatic HTTPS. Use it
as the `--url` value in [Step 5](#5-pair-your-phone). To let channel
integrations use it as well, run `vellum tunnel --provider tailscale` instead,
which also writes it to `ingress.publicBaseUrl`.

</details>

<details>
<summary>Public alternatives: ngrok / Cloudflare quick tunnels</summary>

If you can't use Tailscale, expose the edge over the public internet:

```bash
vellum tunnel --provider cloudflare   # quick tunnel, no account required
vellum tunnel --provider ngrok        # requires an ngrok account
```

**Privacy trade-off:** these publish a public-internet URL, so anyone who
learns the URL can reach your assistant's sign-in and pairing page (pairing
still requires local approval, but the surface is public). The Tailscale path
keeps the edge visible only to devices on your own tailnet.

</details>

## 5. Pair your phone

On the host, generate a single-scan pairing QR pointed at your HTTPS address:

```bash
vellum pair --qr --url https://your-assistant.ts.net
```

This mints a pairing challenge and approves it locally — running the command
on the host _is_ the proof of presence — then renders a QR code (and the same
URL as text) in your terminal. The URL must be public HTTPS; the command
refuses loopback or plain-HTTP addresses.

On your phone:

1. Make sure Tailscale is connected (for a `ts.net` address) or that you're
   on any network (for a public tunnel).
2. Open the **system camera** and point it at the QR code, then tap the
   notification. Safari opens the pairing page **already approved** and shows
   **Connected**.
3. Use the browser **Share → Add to Home Screen** to install the assistant as
   an app icon.

The pairing session survives assistant restarts via a refresh cookie, so you
stay signed in. Pairing codes are **single-use and expire after 10 minutes** —
to add another device (or if a code lapses), just run `vellum pair --qr`
again.

## 6. Native iOS shell (optional, for developers)

The steps above give you a full-screen web app via Add to Home Screen, which
is enough for most people. If you want to build the native Capacitor iOS shell
against your own origin, point it at your host's HTTPS URL:

```bash
cd clients/web
VELLUM_SERVER_URL=https://your-assistant.ts.net bun run ios:open
```

`VELLUM_SERVER_URL` must be a valid `https:` URL (iOS App Transport Security
requires real TLS). See [`clients/ios/README.md`](../clients/ios/README.md)
for prerequisites, signing, and the full build flow.

## Good to know

- **Your laptop has to be awake.** The assistant runs on your machine, so if
  it's asleep or offline, the phone can't reach it.
- **No background push in this mode.** You get live streaming while the app is
  in the foreground, but no push notifications. For proactive pings, connect a
  channel like Telegram — those deliver notifications independently.
- **Tailnet-private by default.** `tailscale serve` exposes the edge only to
  your own devices, not the public internet. Reach for a public tunnel
  (Step 4) only if you accept the privacy trade-off.
- **Pairing codes are single-use and expire in 10 minutes.** Re-run
  `vellum pair --qr` whenever you need a fresh one.
