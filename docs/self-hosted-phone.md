# Your self-hosted assistant on your devices

Reach a self-hosted Vellum assistant from your other devices — a phone, a
tablet, another computer — with no dependency on hosted Vellum. Everything
runs on your own machine; each device connects straight to it over an HTTPS
address you control, and a QR code (or its printed URL) pairs a device in a
single scan.

Connect from any browser (on phones and tablets, add it to your home screen
for a full-screen PWA) or from the native **Vellum iOS app** pointed at your
own server (see [Using the Vellum iOS app](#5-using-the-vellum-ios-app)). All
paths reach the same assistant.

This is a CLI-driven flow for people who already run their assistant locally
(`vellum wake`). If you use the managed Vellum Cloud app, you don't need any of
this; sign in and your devices are already connected.

> **Check your version first.** This flow uses recent additions to the `vellum`
> CLI and the assistant it runs: remote web ingress (Step 1), `vellum tunnel`
> providers (Step 3), `vellum pair --qr` (Step 4), and the iOS app's connect
> handler (Step 5). They ship in the next release; until then they're available
> on builds from source. Check what you have with `vellum --version` (it prints
> `@vellumai/cli v<version>`). If `vellum tunnel --provider tailscale` reports
> `not yet implemented` or `vellum pair --qr` isn't recognized, your CLI
> predates this flow — update it once the release lands, or build from source
> (the web app in [Step 2](#2-the-web-app-ships-with-the-cli) and the iOS shell
> in [Step 6](#6-native-ios-shell-optional-for-developers) both note how).

## How it works

```
your devices (any browser · PWA · Vellum iOS app)
   │  HTTPS
   ▼
Tailscale front  (https://your-assistant.ts.net)
   │
   ▼
nginx edge  (127.0.0.1:7840)  ──►  serves the web app
   │                               proxies /v1 and /webhooks to the gateway
   ▼
gateway ──► assistant
```

The nginx edge is the single public surface: it serves the web app and
forwards API and webhook traffic to the gateway. `vellum tunnel` starts and
manages the edge automatically. An HTTPS front (Tailscale by default)
terminates TLS and makes the edge reachable from your devices.

## Before you start

- The `vellum` CLI installed, with an assistant hatched and awake
  (`vellum wake`). Every command below talks to the running assistant.
- **nginx** installed:
  - macOS: `brew install nginx`
  - Linux: `sudo apt install nginx`
- **Tailscale** installed on the host machine and on every device you'll
  connect, all signed into the same tailnet. (Only needed for the default
  private path; see [Step 3](#3-put-an-https-address-in-front) for public
  alternatives.)
- If you run more than one local assistant, decide which one your devices
  connect to: every step below applies to a single assistant (see
  [Step 1](#1-enable-remote-web-ingress)).

## 1. Enable remote web ingress

Remote web access is gated behind a feature flag. Turn it on for your
assistant:

```bash
vellum flags set web-remote-ingress true
```

> **One assistant at a time.** The feature flag, the tunnel URL, and pairing
> all belong to a _specific_ assistant. With several local assistants, point
> every step at the same one. `vellum ps` lists them and marks the active one
> with `*`. `pair`, `tunnel`, and `nginx-ingress` take an assistant name as
> their first argument (e.g. `vellum tunnel my-assistant`); `vellum flags`
> takes `--assistant <name>`.

**Verify:** `vellum flags get web-remote-ingress` prints `Enabled: true`.

## 2. The web app ships with the CLI

The `vellum` CLI includes a prebuilt bundle of the web app, compiled for
self-hosting (pointed at your own gateway, not Vellum Cloud). The nginx edge
that `vellum tunnel` manages in the next step finds it automatically; there
is nothing to build.

To open the web UI on the host machine itself, serve the same bundle locally:

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

**Verify:** `vellum client --interface web` prints
`Vellum web interface: http://localhost:<port>/assistant/` and that page loads
your assistant on the host. Press Ctrl+C to stop it — your other devices
don't use this local server.

## 3. Put an HTTPS address in front

Your devices need an HTTPS URL that reaches your assistant. **Tailscale is
the recommended front**: the assistant stays private to your own devices and
the address is permanent, so each device pairs once and stays connected. The
public alternatives below are instant but internet-exposed, and a Cloudflare
quick tunnel's URL is temporary on top (details in its section below).

```bash
vellum tunnel --provider tailscale
```

`vellum tunnel` manages the nginx edge for you: it starts the edge on
`http://127.0.0.1:7840` (or reuses one already running) and fronts it, so a
single address serves the web app and forwards API and webhook traffic to
the gateway. nginx must be installed (see
[Before you start](#before-you-start)); without it the command fails with
install instructions. The edge listen port defaults to `7840`; override it
with the `VELLUM_NGINX_INGRESS_PORT` environment variable if it clashes with
something else. To inspect or stop the edge later:

```bash
vellum nginx-ingress status   # is the edge running, in which mode, and where
vellum nginx-ingress down     # stop the edge
```

The tunnel records the public URL in your workspace config
(`ingress.publicBaseUrl`), so channel integrations (Telegram, Twilio, …) can
reach the assistant too. It prints the address it established:

```
Tunnel established: https://your-machine.your-tailnet.ts.net
```

That `https://<machine>.<tailnet>.ts.net` is **your own machine's address on
your tailnet, not a Tailscale website** — it's the URL your devices open. You
won't type it again by hand: the pairing step reuses this saved address
automatically.

**Verify:** open that `https://…ts.net` address in the browser of a device
you want to connect (with Tailscale connected on it). You should get the
assistant's sign-in page. If it doesn't load, stop and fix this before
pairing — a broken HTTPS front is the most common reason later steps fail.

<details>
<summary>Manual Tailscale fallback (no <code>vellum tunnel</code> needed)</summary>

Tailscale can serve the edge directly. Start the edge yourself, then serve
it (this works on any recent Tailscale install):

```bash
vellum nginx-ingress up
tailscale serve --bg 7840
tailscale serve status   # prints your https://<host>.<tailnet>.ts.net URL
```

That URL fronts the nginx edge over your tailnet with automatic HTTPS. Use it
as the `--url` value in [Step 4](#4-pair-your-devices). To let channel
integrations use it as well, run `vellum tunnel --provider tailscale` instead,
which manages the edge itself and also writes the URL to
`ingress.publicBaseUrl`.

</details>

<details>
<summary>Public alternatives: ngrok / Cloudflare quick tunnels</summary>

If you can't use Tailscale, expose the edge over the public internet:

```bash
vellum tunnel --provider cloudflare   # quick tunnel, no account required
vellum tunnel --provider ngrok        # requires an ngrok account
```

A Cloudflare quick tunnel prints a `https://<random>.trycloudflare.com`
address (ngrok prints a similar per-tunnel URL). Either one is the public
address of **your** machine — use it wherever this guide asks for your HTTPS
URL.

**Cloudflare quick tunnels are temporary by design:** the
`trycloudflare.com` URL changes every time the tunnel restarts, and paired
devices point at the old address — you re-pair each device after every
restart. Good for trying the flow; switch to Tailscale for a permanent
setup. ngrok URLs follow your ngrok account instead: with a reserved ngrok
domain the address survives restarts, so paired devices keep working. Bind
one with `--domain`:

```bash
vellum tunnel --provider ngrok --domain my-assistant.ngrok.app
```

The domain is saved to the workspace config. `vellum wake` restores the
tunnel automatically only when a messaging channel like Telegram or Twilio is
configured; otherwise rerun `vellum tunnel --provider ngrok` after a restart
and the saved domain is reused.

**Privacy trade-off:** these publish a public-internet URL, so anyone who
learns the URL can reach your assistant's sign-in and pairing page (pairing
still requires local approval, but the surface is public). The Tailscale path
keeps the edge visible only to devices on your own tailnet.

</details>

## 4. Pair your devices

On the host, generate a single-scan pairing QR:

```bash
vellum pair --qr
```

If you put the HTTPS front in place with `vellum tunnel` (Step 3),
`vellum pair --qr` reuses that saved address automatically and prints
`Using saved ingress URL … (from vellum tunnel; override with --url)` — so you
don't need to know or retype your URL. Pass `--url` to advertise a different
address, or when using the manual `tailscale serve` fallback, which doesn't
save one:

```bash
vellum pair --qr --url https://your-machine.your-tailnet.ts.net
```

The advertised URL must be public HTTPS — e.g.
`https://<machine>.<tailnet>.ts.net` (Tailscale) or
`https://<random>.trycloudflare.com` (a Cloudflare quick tunnel); the command
refuses loopback and plain-HTTP addresses. It mints a pairing challenge and
approves it locally (running it on the host is the proof of presence), then
renders a QR code and the same URL as text in your terminal.

On the device you're pairing:

1. Make sure Tailscale is connected on it (for a `ts.net` address) or that
   it's on any network (for a public tunnel).
2. On a phone or tablet, open the **system camera** and point it at the QR
   code, then tap the notification to open the pairing page. On a device
   without a camera (another computer), open the URL printed under the QR in
   its browser instead. The result is the same. On iOS and Android the page
   first offers
   **Open in the Vellum app** or **Continue in this browser**; tap
   **Open in the Vellum app** to finish pairing in the native app, or
   **Continue in this browser** to pair here. See
   [Using the Vellum iOS app](#5-using-the-vellum-ios-app) for iOS details.
3. On phones and tablets, use the browser **Share → Add to Home Screen** to
   install the assistant as an app icon.

**Verify:** after scanning, the pairing page shows **Connected** — pairing is
already approved, so there's nothing to confirm — and your assistant loads.

The pairing session survives assistant restarts via a refresh cookie, so you
stay signed in. Pairing codes are **single-use and expire after 10 minutes**;
run `vellum pair --qr` again to add another device or replace a lapsed code.

**Prefer a UI over the terminal?** The desktop app has the same flow as a
card: **Settings → General → Pair a device**. It prefills the address
`vellum tunnel` recorded (or shows "No tunnel detected" guidance when there
isn't one), rejects lookalike tunnel-provider website URLs, and names the
assistant it pairs — generate the QR there and scan it the same way.

## 5. Using the Vellum iOS app

The native **Vellum iOS app** can point at your self-hosted assistant instead
of Vellum Cloud, giving you the full app shell against your own server rather
than a home-screen web page. Steps 1–4 are identical; only the way the phone
connects changes.

> **Build requirement.** The app's connect handler ships in the next app
> release (TestFlight, then the App Store) — see the version note at the top of
> this guide. On an older build, use the browser / Add to Home Screen path in
> [Step 4](#4-pair-your-devices), which keeps working unchanged. Building the
> shell from source ([Step 6](#6-native-ios-shell-optional-for-developers))
> produces a build that carries it today.

**Recommended: scan the Step 4 QR, then tap "Open in the Vellum app."** You
don't need a different command: the QR from `vellum pair --qr` (Step 4)
already works for the app:

1. Point the phone's **system camera** at the QR and open the pairing page in
   Safari.
2. Tap **Open in the Vellum app** (instead of **Continue in this browser**).
   The app saves your server and finishes pairing. Because the handoff happens
   before the single-use code is spent, **Continue in this browser** still
   works if the app isn't installed.

The saved server and the pairing belong to the assistant you targeted in
Steps 1–4. With several local assistants, keep them all pointed at the same
one (`vellum ps` shows the active one).

**Verify:** the app opens to your own assistant, not Vellum Cloud.

<details>
<summary>Other ways to connect</summary>

**One-scan app QR** — use when every target phone already has the app
installed (this QR opens the app directly and has no browser fallback):

```bash
vellum pair --qr --app
```

This encodes the pairing as a `vellum-assistant://connect` link; the plain
https pairing URL is printed beneath it. Point the **system camera** at it and
the app opens (cold-launching if it was closed), saves your server, and
completes pairing in a single scan. Like plain `--qr`, it reuses the
`vellum tunnel` address; pass `--url` to override. Target a non-production
build with `--app-scheme` (`vellum-assistant-dev` for a dev build,
`vellum-assistant-staging` for staging):

```bash
vellum pair --qr --app --app-scheme vellum-assistant-dev
```

**Enter the server by hand** — use when you'd rather not scan. Open the iOS
**Settings** app, tap **Vellum**, and use the **Self-Hosted Server** section:
enter your assistant's HTTPS URL, the same `https://<machine>.<tailnet>.ts.net`
address `vellum pair --qr` prints. Leaving the field empty keeps the app on
Vellum Cloud; the app reloads on next launch. You still pair the device once —
by any method above, or a browser sign-in — for the app to have access. If the
app can't reach the configured server, it shows **Can't reach `<host>`.** with
**Retry** and **Use Vellum Cloud**; **Use Vellum Cloud** (or clearing the
field yourself) returns the app to Vellum Cloud.

</details>

The [Good to know](#good-to-know) notes below apply to the app just as they do
to the browser path.

## 6. Native iOS shell (optional, for developers)

The browser (Step 4) and released-app (Step 5) paths above cover most people.
If you want to build the native Capacitor iOS shell yourself — for example to
get the app features before they reach TestFlight — point it at your host's
HTTPS URL:

```bash
cd clients/web
VELLUM_SERVER_URL=https://your-machine.your-tailnet.ts.net bun run ios:open
```

`VELLUM_SERVER_URL` must be a valid `https:` URL (iOS App Transport Security
requires real TLS). See [`clients/ios/README.md`](../clients/ios/README.md)
for prerequisites, signing, and the full build flow.

**Verify:** the app launches on the simulator or device pointed at your host
URL — you reach your own assistant, not Vellum Cloud.

## Good to know

- **Your laptop has to be awake.** The assistant runs on your machine, so if
  it's asleep or offline, your devices can't reach it.
- **No background push in this mode.** You get live streaming while the app is
  in the foreground, but no push notifications. For proactive pings, connect a
  channel like Telegram, which delivers notifications independently.
- **Tailnet-private by default.** `tailscale serve` exposes the edge only to
  your own devices, not the public internet. Use a public tunnel
  ([Step 3](#3-put-an-https-address-in-front)) only if you accept
  the privacy trade-off.
- **Pairing codes are single-use and expire in 10 minutes.** Re-run
  `vellum pair --qr` whenever you need a fresh one.
