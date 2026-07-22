# Your self-hosted assistant on your phone

Reach a self-hosted Vellum assistant from your phone with no dependency on
hosted Vellum. Everything runs on your own machine; your phone connects
straight to it over an HTTPS address you control, and a QR code pairs the
device in a single scan.

Connect from a mobile browser (add it to your home screen for a full-screen
PWA) or, on a recent build, from the native **Vellum iOS app** pointed at your
own server — see [Using the Vellum iOS app](#6-using-the-vellum-ios-app). Both
reach the same assistant.

This is a CLI-driven flow for people who already run their assistant locally
(`vellum wake`). If you use the managed Vellum Cloud app, you don't need any
of this — sign in and your phone is already connected.

## How it works

```
phone (Safari · installed PWA · Vellum app)
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

## 2. The web app ships with the CLI

There's nothing to build: the `vellum` CLI already includes a prebuilt bundle
of the web app compiled for self-hosting (pointed at your own gateway, not
Vellum Cloud). The nginx edge in the next step finds it automatically.

To try the web UI on the host machine right now, serve that same bundle
locally:

```bash
vellum client --interface web
```

<details>
<summary>Running from a source checkout?</summary>

A source checkout has no prebuilt bundle, so build the web app in self-hosted
mode before starting the edge:

```bash
cd clients/web && VITE_PLATFORM_MODE=false bun run build
```

</details>

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

On the host, generate a single-scan pairing QR:

```bash
vellum pair --qr
```

If you put the HTTPS front in place with `vellum tunnel` (Step 4),
`vellum pair --qr` reuses that saved address automatically — it prints
`Using saved ingress URL … (from vellum tunnel; override with --url)`, so you
don't pass a URL at all. Add `--url` to advertise a different address (and for
the manual `tailscale serve` fallback, which doesn't save one):

```bash
vellum pair --qr --url https://your-assistant.ts.net
```

Either way the command mints a pairing challenge and approves it locally —
running it on the host _is_ the proof of presence — then renders a QR code (and
the same URL as text) in your terminal. The advertised URL must be public
HTTPS; the command refuses loopback or plain-HTTP addresses.

On your phone:

1. Make sure Tailscale is connected (for a `ts.net` address) or that you're
   on any network (for a public tunnel).
2. Open the **system camera** and point it at the QR code, then tap the
   notification to open the pairing page in Safari. On iOS the page first
   offers **Open in the Vellum app** or **Continue in this browser** — tap
   **Continue in this browser** to pair here (see
   [Using the Vellum iOS app](#6-using-the-vellum-ios-app) for the app path).
   The page then shows **Connected**; pairing is already approved, so there's
   nothing to confirm.
3. Use the browser **Share → Add to Home Screen** to install the assistant as
   an app icon.

The pairing session survives assistant restarts via a refresh cookie, so you
stay signed in. Pairing codes are **single-use and expire after 10 minutes** —
to add another device (or if a code lapses), just run `vellum pair --qr`
again.

## 6. Using the Vellum iOS app

The native **Vellum iOS app** can point at your self-hosted assistant instead of
Vellum Cloud, giving you the full app shell — not just a home-screen web page —
against your own server. Steps 1–4 are identical; only the way the phone
connects changes.

> **Build requirement.** These app features ship in the next app release
> (TestFlight, then the App Store). On an older build, use the browser / Add to
> Home Screen path in [Step 5](#5-pair-your-phone) — it keeps working
> unchanged. Building the shell from source
> ([Step 7](#7-native-ios-shell-optional-for-developers)) also produces a build
> that carries them today.

All three connection methods below reach the same nginx edge you set up above.

### Open the app from the default QR (works for everyone)

The QR from `vellum pair --qr` (Step 5) already serves app users. On iOS its
pairing page leads with **Open in the Vellum app** and offers **Continue in
this browser** underneath. Tapping **Open in the Vellum app** hands the pairing
to the app _before_ the single-use code is spent, so **Continue in this
browser** still works if the app isn't installed. This one QR is the right
choice when your phones are a mix of app and browser users.

### Scan straight into the app with `--app`

To make a QR that opens the app directly, add `--app`:

```bash
vellum pair --qr --app
```

This encodes the pairing as a `vellum-assistant://connect` link; the plain
https pairing URL is printed beneath it as a fallback. Point the **system
camera** at the QR and the app opens — cold-launching if it was closed — saves
your server, and completes pairing in a single scan. Like plain `--qr`, it
reuses the `vellum tunnel` address automatically; pass `--url` to override.

An `--app` QR only opens on a phone that already has the app installed, so
reach for it when every target device has the app. Use `--app-scheme` to target
a non-production build (`vellum-assistant-dev` for a dev build,
`vellum-assistant-staging` for staging):

```bash
vellum pair --qr --app --app-scheme vellum-assistant-dev
```

### Enter the server by hand in Settings

To point the app at your server without scanning, open the iOS **Settings** app,
tap **Vellum**, and use the **Self-Hosted Server** section: enter your
assistant's HTTPS URL (the field shows a `https://` placeholder) — the same
`https://…ts.net` address `vellum pair --qr` prints. Leaving it empty keeps the
app on Vellum Cloud. The app applies the change when you reopen it. You still
pair the device once — by any method above, or a browser sign-in — for the app
to have access.

If the app can't reach the configured server, it shows an alert —
**Can't reach `your-assistant.ts.net`.** — with **Retry** and **Use Vellum
Cloud**. **Use Vellum Cloud** clears the field and returns the app to Vellum
Cloud; clearing the field yourself does the same.

The [Good to know](#good-to-know) notes below — laptop awake, no background
push, single-use 10-minute codes — apply to the app just as they do to the
browser path.

## 7. Native iOS shell (optional, for developers)

The browser (Step 5) and released-app (Step 6) paths above cover most people.
If you want to build the native Capacitor iOS shell yourself — for example to
get the app features before they reach TestFlight — point it at your host's
HTTPS URL:

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
