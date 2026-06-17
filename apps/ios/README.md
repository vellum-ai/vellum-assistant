# Capacitor iOS shell

Native iOS wrapper built with [Capacitor](https://capacitorjs.com/).
This is _not_ a port of the web app — it's a thin `WKWebView` shell in
`server.url` mode that loads the live web app directly over HTTPS.

## Web content delivery

**What:** The iOS app loads the web UI live over HTTPS from the deployed
web origin (e.g. `https://www.vellum.ai/assistant`). No web assets are
bundled in the IPA — the `webDir` (`capacitor-shell/`) contains only a
placeholder HTML page that is never shown at runtime.

**How:** `capacitor.config.ts` sets
[`server.url`](https://capacitorjs.com/docs/guides/server-url) to the
environment-appropriate origin. `cap sync ios` bakes that URL into the
native `capacitor.config.json`. At launch, `WKWebView` navigates
straight to it. Each environment (production, staging, dev) has its own
origin — set `VELLUM_ENVIRONMENT` before `bunx cap sync ios` to select
which URL is baked into the build.

**Why remote URL, not a local bundle (like the Electron app):**

- **Instant web updates** — deploying to the web origin is immediately
  live for every iOS user on their next app load. No App Store review,
  no TestFlight build, no update prompt. This decouples web deploy
  frequency from the native release cycle.
- **App Store review avoidance** — Apple's review process can take hours
  to days. Bundling web assets would gate every web change behind that
  process. With `server.url`, only native shell changes (Swift code,
  entitlements, Capacitor plugin updates) require a store submission.
- **Thin native surface** — the IPC bridge between the WKWebView and
  native code is minimal (two plugins: `NativeAuthPlugin` and
  `NativeBiometricPlugin`), so version skew risk between the web app
  and native shell is low. Contrast with the Electron app, where the
  `window.vellum.*` IPC surface is broad and tightly coupled.
- **WKWebView security model** — unlike Electron's renderer, `WKWebView`
  runs in a full iOS process sandbox with no access to native APIs
  outside the Capacitor bridge. Loading remote content is the standard
  pattern for Capacitor apps — see Capacitor's
  [server.url guide](https://capacitorjs.com/docs/guides/server-url).

**Tradeoff:** The app requires a network connection to load the UI. This
is acceptable because the assistant needs its backend services for all
functionality anyway — there is no useful offline state.

## Prerequisites

- macOS with **Xcode 16+** (16 or newer is required for the Icon
  Composer `.icon` format; verified on Xcode 26.2)
- [`xcodegen`](https://github.com/yonaskolb/XcodeGen) on `$PATH`:
  `brew install xcodegen`
- Membership in the Vocify, Inc. Apple Developer team for signing
- Node + `bun` — the JS deps live in `../web/`, not here
- No CocoaPods needed — native deps are vendored via Swift Package
  Manager (see `App/CapApp-SPM/Package.swift`)

## How the Xcode project is generated

`App.xcodeproj/` is **not committed**. Everything inside it (`project.pbxproj`,
all `.xcscheme` files, `contents.xcworkspacedata`, the SPM workspace
state) is regenerated from `App/project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen) every time you build —
locally via `bun run ios:setup`, in CI via the `xcodegen generate` step
in `.github/workflows/release-ios.yaml`.

What _is_ committed and what generates from where:

| File / directory                           | Source of truth | Status     |
| ------------------------------------------ | --------------- | ---------- |
| `App/project.yml`                          | Hand-authored   | Committed  |
| `App/App/Config/*.xcconfig`                | Hand-authored   | Committed  |
| `App/CapApp-SPM/Package.swift`             | `cap sync ios`  | Committed  |
| `App/App.xcodeproj/**`                     | `xcodegen`      | Gitignored |
| `App/App/capacitor.config.json`            | `cap sync ios`  | Gitignored |
| `App/App/config.xml`                       | `cap sync ios`  | Gitignored |
| `App/App/public/`                          | `cap sync ios`  | Gitignored |

A pre-build script wired into every target via `project.yml` fails the
Xcode build with a clear error if `project.yml` is newer than the
generated `App.xcodeproj/project.pbxproj` — i.e. you pulled a
`project.yml` change but forgot to regenerate. The fix is always the
same: `bun run ios:setup` from `apps/web/`.

## First-time setup

From `apps/web/`:

```bash
bun install            # installs @capacitor/cli and Capacitor plugin deps
bun run ios:open        # cap sync + xcodegen generate + open Xcode
```

`bun run ios:open` is idempotent — running it on an already-up-to-date
tree is a no-op. Two underlying scripts are also available individually:

- `bun run ios:setup` — `cap sync ios` + `xcodegen generate`. Use when
  you want to run `xcodebuild` headlessly (rare for local dev).
- `bun run ios:open` — `bun run ios:setup` + `open ../ios/App/App.xcodeproj`.
  Day-to-day local flow.

First-time open takes ~30s while Xcode resolves the SPM graph and
caches `capacitor-swift-pm@8.3.4` (pinned exactly in
`CapApp-SPM/Package.swift`).

> **No `App.xcworkspace`** — CocoaPods-based Capacitor projects ship
> one; ours uses SPM, so the `.xcodeproj` is the entry point directly.

## Pick a scheme and simulator

When Xcode opens the regenerated project for the first time it picks
**"App"** alphabetically as the active scheme — that's the production
target, which is _not_ what you want for local dev.

In the Xcode toolbar:

1. **Scheme dropdown** (left of the run button): pick **App Dev** (or
   App Staging — see the table below). Xcode
   stores the choice in `xcuserdata/<user>.xcuserdatad/xcschememanagement.plist`,
   which is gitignored and survives `xcodegen generate` runs, so you
   only have to do this once per machine.
2. **Run-destination dropdown** (right of the scheme): pick a
   simulator — **iPhone 16 Pro · iOS 18+** is a good default — or
   plug in a device and select it.
3. **App target → Signing & Capabilities → Team**: pick **Vocify, Inc.**
   Xcode auto-generates a local provisioning profile.
4. **⌘R** to build and run.

Apple's reference for the toolbar controls:
[Running your app in Simulator or on a device](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device).

## Debugging

The app has two layers — the **WKWebView contents** (the React app loaded
from the configured server URL) and the **native Swift shell** (Capacitor
bridge, `MyViewController`, the two native plugins). Each has its own
debugger.

### Safari Web Inspector — for the web side (JS / CSS / network / `console.log`)

This is the one you'll use most. It's full Safari devtools attached to
the WKWebView, so the Elements panel, Console, Network, Sources,
debugger, and `console.log` output all work the way they do in a normal
browser tab.

One-time Safari setup on your Mac:

1. Safari → Settings → **Advanced** → check **"Show features for web
   developers"** (older macOS: "Show Develop menu in menu bar").

Per-session, with the app running in the simulator (or on a tethered
device):

1. Safari → **Develop** menu → pick the simulator (e.g. "Simulator —
   iPhone 16 Pro") or your connected device → click the entry under the
   app's bundle ID (`…vellum-assistant-ios.dev` for App Dev).
2. The Web Inspector window opens against the live WebView. Reloading the
   app, navigating, or `cmd+R`-ing in Xcode all keep working — just
   reopen the inspector entry from the Develop menu when the WebView
   reloads.

This works because Capacitor enables `WKWebView.isInspectable` on Debug
builds automatically ([Capacitor 6+ default](https://capacitorjs.com/docs/ios/troubleshooting#using-safari-web-inspector));
Release / TestFlight builds are not inspectable, which is intentional.

For a **physical iPhone**:

1. On the phone: Settings → Apps → Safari → Advanced → toggle **Web
   Inspector** on.
2. Plug it in via USB and trust the Mac.
3. The device shows up in Safari's Develop menu the same way the
   simulator does.

> If the simulator/device shows up in the Develop menu but the app's
> entry doesn't, the WebView hasn't loaded yet — wait for the splash
> screen to dismiss, or you're running a Release build (only Debug is
> inspectable).

### Xcode debugger — for native Swift code

⌘R runs with `lldb` already attached. Click in the gutter next to any
line in `AppDelegate.swift`, `MyViewController.swift`,
`NativeAuthPlugin.swift`, or `NativeBiometricPlugin.swift` to set a
breakpoint.

- **Console / log output**: View → Debug Area → Activate Console (⇧⌘Y),
  or click the bottom-right console toggle. `print()` and `NSLog()` from
  Swift show up here, as do Capacitor's plugin-bridge logs.
- **`console.log` from the web side does NOT appear in the Xcode
  console** — it goes to Safari Web Inspector only. Don't waste time
  looking for it here.
- **Pause on first load**: breakpoint on `capacitorDidLoad()` in
  `MyViewController.swift` to inspect the bridge state before any plugin
  has been called.
- **View hierarchy**: Debug → View Debugging → Capture View Hierarchy
  shows the native view tree (useful for confirming the WebView is
  laid out correctly under the notch — though most layout debugging
  belongs in the Web Inspector, not here).

### Common debugging recipes

- **A native plugin call (`NativeAuth`, `NativeBiometric`) seems broken**:
  set a Swift breakpoint in the relevant `@objc func` inside the plugin
  file and trigger the action from the web app. If the breakpoint never
  hits, the JS-side `Capacitor.Plugins.NativeAuth` lookup is wrong (check
  `src/runtime/native-auth.ts` / `native-biometric.ts`). If it hits but
  doesn't return, step through and check `call.resolve` / `call.reject`.
- **A streaming/SSE bug only reproduces in the iOS shell**: open Safari
  Web Inspector → Network → filter for `text/event-stream`. You should
  see the connection stay open with `data:` frames arriving. If you see
  the whole response delivered in one chunk, CapacitorHttp has been
  enabled somewhere (it shouldn't be — see the
  [CapacitorHttp section](#capacitorhttp-is-deliberately-off)).
- **The WebView never loads, just a blank green screen**: check the
  Xcode console for a failed navigation. Common cause is a typo'd
  `server.url` in `capacitor.config.ts` or `cleartext: true` missing for
  an HTTP target. The placeholder `capacitor-shell/index.html` is also
  what flashes briefly before the remote URL paints.

## How it's set up

> **Web-side conventions for iOS code paths**: any change to the web app
> that might run inside this WKWebView shell needs to follow the patterns
> in [`apps/web/docs/CAPACITOR.md`](../web/docs/CAPACITOR.md) — Capacitor plugin
> lazy imports, native auth, deep links, autogrowing textareas,
> streaming watchdogs, OS permission UI, etc.

### `server.url` mode, not static export

See [Web content delivery](#web-content-delivery) for the full
what / how / why. The `/assistant` path suffix is deliberate — booting
on the bare host lands on the marketing page, whose CTA redirects to
`www.vellum.ai/assistant` and bounces non-prod shells off their own host.

**Do not** switch to a static `vite build` output that bundles web
assets into the IPA. We deliberately serve from the live web origin
so SSE streaming, Sentry sourcemaps, auth cookies, and feature flags
all keep working unchanged.

### CapacitorHttp is deliberately off

We use the native `WKWebView` `fetch` path, not the CapacitorHttp plugin.
CapacitorHttp intercepts `fetch` and routes through native networking,
which breaks Server-Sent Events (SSE) streaming — that's how the chat
experience works. Do not enable it.

### Targets and environments

The Xcode project has three targets — one per environment. Each has its own
bundle ID, display name, and icon colour so they can be installed side by
side on the same device.

| Target | Bundle ID | Display Name | Icon | Server |
|--------|-----------|-------------|------|--------|
| App | `ai.vocify-inc.vellum-assistant-ios` | Vellum | Green | `www.vellum.ai` |
| App Staging | `.staging` | Vellum Staging | Yellow | staging server |
| App Dev | `.dev` | Vellum Dev | Pink | dev server |

Build settings shared across all three targets live in
`App/App/Config/Base.xcconfig`. Per-target overrides (bundle ID, display
name, icon) live in `App/App/Config/App-<env>.xcconfig`. Debug-specific
flags (`OTHER_SWIFT_FLAGS`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS`) live
inline in `App/project.yml` under the `AppEnvironment` template.

### App icon + launch screen

- `App/App/AppIcon.icon/` is an Icon Composer bundle (green background +
  white "V"). It uses the same visual design as the macOS app icon
  source SVG ([`vellum-assistant/apps/macos/build-resources/icons/production/Assets/white-V.svg`](https://github.com/vellum-ai/vellum-assistant/blob/main/apps/macos/build-resources/icons/production/Assets/white-V.svg)),
  but is its own Icon Composer bundle living in this repo.
- `AppIcon-Staging.icon` (yellow) and `AppIcon-Dev.icon` (pink) follow
  the same structure — only the `fill.solid` colour differs.
- `App/App/Base.lproj/LaunchScreen.storyboard` references the `Splash`
  imageset in `Assets.xcassets/`. Those 2732×2732 PNGs are a solid green
  background with a centered white V — same palette as the icon.

### Bundle ID vs capacitor.config appId

There's a deliberate mismatch:

| Where                       | Value                                      |
| --------------------------- | ------------------------------------------ |
| Xcode `PRODUCT_BUNDLE_IDENTIFIER` | `ai.vocify-inc.vellum-assistant-ios` ← real one |
| `capacitor.config.ts` `appId`     | `ai.vocify.vellumassistantios`                  |

Capacitor's CLI rejects `appId`s with hyphens (it requires Java package
form), but Apple's bundle ID rules _do_ allow hyphens — and our existing
App Store Connect app, signing cert, and provisioning profile all use
the hyphenated form. The hyphen-free `appId` exists only to satisfy
`cap init` / `cap add` / `cap sync` validation. **Do not "fix" this
mismatch** — doing so would require re-provisioning the entire app.
See the inline comment in `capacitor.config.ts`.

## Common tasks

### After editing `apps/web/capacitor.config.ts`

```bash
cd apps/web
bun run ios:setup
```

`ios:setup` re-runs `cap sync ios` (regenerating
`apps/ios/App/App/capacitor.config.json` and the `capacitor-shell/` webDir
copy in `apps/ios/App/App/public/`) and then `xcodegen generate` to refresh
`App.xcodeproj/`. All three of those output paths are gitignored.

### Point at a local Next.js instead of `dev-assistant`

Temporarily edit `capacitor.config.ts`:

```ts
server: {
  url: "http://192.168.x.x:3000", // your Mac's LAN IP — not localhost
  cleartext: true,                 // HTTP, not HTTPS
},
```

- Use your LAN IP, not `localhost` / `127.0.0.1` — the simulator shares
  the host's loopback but a device won't
- `cleartext: true` is needed because iOS App Transport Security blocks
  HTTP by default
- Run `bunx cap sync ios`, then rebuild in Xcode
- **Revert before committing.** The default must remain
  the dev server URL with `cleartext: false`.

### Add a new Capacitor plugin

`cap sync ios` auto-generates `CapApp-SPM/Package.swift` from the
installed `@capacitor/*` packages — you **must** commit the resulting
`Package.swift` change, otherwise the Xcode build will fail for anyone
who clones fresh. ([Capacitor SPM docs](https://capacitorjs.com/docs/ios/spm))

```bash
cd apps/web
bun add @capacitor/<plugin-name>   # adds to package.json + bun.lock
bun run ios:setup                   # cap sync regenerates Package.swift; xcodegen wires it into the project
```

Then `git diff apps/ios/App/CapApp-SPM/Package.swift` — you should see
the new dependency + product. **Commit `package.json`/`bun.lock` and
`Package.swift` in the same PR.** The regenerated `App.xcodeproj/` is
gitignored, so don't try to commit it.

### Update Capacitor

Version bumps live in `apps/web/package.json` (`@capacitor/core`, `@capacitor/ios`,
`@capacitor/cli` — all pinned to exact versions per the repo rule). After
bumping:

```bash
cd apps/web
bun install
bun run ios:setup
bunx cap update ios   # only if @capacitor/ios major changed; re-run ios:setup after
```

`@capacitor/ios` major bumps may require updating the SPM pin in
`CapApp-SPM/Package.swift` (`exact:` version) — `cap sync` writes
that for you when the npm package version changes.

## Testing checklist

On first build after pulling:

- [ ] Home-screen icon is Vellum green with a white "V" (not the blue X
      Capacitor placeholder)
- [ ] Launch screen briefly flashes green + V
- [ ] WebView loads the configured server URL and you can sign in
- [ ] Chat streams token-by-token (verifies SSE is intact — if tokens
      arrive in one big blob, CapacitorHttp got turned on somewhere)
- [ ] Photo / file attachments work (exercises the WKWebView file-picker
      bridge)
- [ ] Xcode → App target → General → Bundle Identifier reads
      `ai.vocify-inc.vellum-assistant-ios`

## Gotchas

- **`open App.xcworkspace` doesn't exist** — we're on SPM, not
  CocoaPods. Use `App.xcodeproj` (regenerated by `bun run ios:setup`).
- **`error: project.yml is newer than App.xcodeproj`** — pre-build
  guard fired. Run `bun run ios:setup` from `apps/web/` and rebuild.
- **actool "no AppIcon stack" error** — `AppIcon.icon` must live at
  `App/App/AppIcon.icon/` (alongside `Info.plist`), _not_ inside
  `Assets.xcassets/`. It's wired into `project.yml` as a per-target
  resource and shows up in the regenerated `project.pbxproj` as a
  `folder.iconcomposer.icon` reference.
- **Splash looks stretched** — the storyboard uses `scaleAspectFill`
  on a 2732×2732 square. On phones this crops horizontally; the
  centered V stays visible.
- **`xcuserdata` and `App.xcodeproj/*` changes in `git status`** —
  expected, both are gitignored. `xcuserdata` is per-user IDE state
  (selected scheme, breakpoints); `App.xcodeproj/*` is regenerated by
  xcodegen on every `bun run ios:setup`.

## CI / Release pipeline

iOS builds are produced by `.github/workflows/release-ios.yaml`, a
reusable workflow called from both `dev-release.yaml` and `release.yml`
in the same repo. This keeps iOS releases in sync with the macOS
release pipeline without cross-repo dispatch complexity.

### How it works

There are three release tracks:

**Dev release** — `dev-release.yaml` runs hourly (cron) or via manual
`workflow_dispatch`. It builds from `main`, and the `release-ios` job
calls `release-ios.yaml` with `environment=dev`.

**Staging release** — `/release` (slash command) runs `create-release-branch.yml`,
which creates a `release/v*` branch. Pushing to that branch triggers
`release.yml` with `is_staging=true`, and the `release-ios` job
calls `release-ios.yaml` with `environment=staging`. A manual
`workflow_dispatch` of `release.yml` from `main` also produces a staging release.

**Production release** — A manual `workflow_dispatch` of `release.yml` on
the `release/v*` branch (not `main`) sets `is_staging=false`, and the
`release-ios` job calls `release-ios.yaml` with `environment=production`.

```
dev-release.yaml (hourly / manual)
  └─ release-ios (uses: release-ios.yaml)
     environment=dev → builds App Dev → TestFlight

release.yml (push to release/v* or manual dispatch from main)
  └─ release-ios (uses: release-ios.yaml)
     environment=staging → builds App Staging → TestFlight

release.yml (manual dispatch on release/v* branch)
  └─ release-ios (uses: release-ios.yaml)
     environment=production → builds App → TestFlight
```

### Workflow

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `release-ios.yaml` | `workflow_call` from release workflows | Automated release builds (dev/staging/production) |

### Environment → scheme mapping

| Environment | Scheme | TestFlight | ExportOptions |
|-------------|--------|------------|---------------|
| `production` | App | External + App Store eligible | `app-store-connect` |
| `staging` | App Staging | Internal only | `app-store-connect` + `testFlightInternalTestingOnly` |
| `dev` | App Dev | Internal only | `app-store-connect` + `testFlightInternalTestingOnly` |

Non-production builds set
[`testFlightInternalTestingOnly`](https://developer.apple.com/documentation/xcode/creating-a-workflow-that-builds-your-app-for-distribution)
in ExportOptions.plist — Apple enforces at the infrastructure level
that these builds cannot be submitted for external testing or App Store
review. This is a real Xcode 15+ key ([App Store Connect Help — Add
internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)).
The export method stays `app-store-connect` for all environments; only
the boolean differs.

### Notifications

The workflow uses the `.github/actions/send-build-alert` composite action
on completion (`if: always()`). Failures surface in `#build-alerts` via
`SLACK_WEBHOOK_URL`.

### Why no `bun run build` before `cap sync`

No web assets are bundled in the IPA (see
[Web content delivery](#web-content-delivery)), so no web build step
is needed before `cap sync`.

### IPA validation before upload

The workflow runs
[`xcrun altool --validate-app`](https://keith.github.io/xcode-man-pages/altool.7.html)
before `--upload-package`. This dry-run checks signing, entitlements,
and App Store Connect requirements without uploading — catching errors
before consuming the build number.

### Xcode version

Workflows pin `Xcode_26.2.app` via `xcode-select`. This path is
confirmed on the `macos-15` GitHub Actions runner image
([runner-images](https://github.com/actions/runner-images)).

### Workflow file conventions

Files are named `.yaml` (not `.yml`) to match the majority convention
in this repo. The iOS release is a reusable `workflow_call`-only
workflow called from the release pipelines — it intentionally has no
`workflow_dispatch` trigger, so all iOS builds flow through the gated
`release.yml` or `dev-release.yaml` chains. Signing steps are not
extracted into their own reusable workflow because it's the only iOS
workflow.

### Secrets (GitHub Actions)

All iOS signing secrets are stored as GitHub Actions secrets:

- `DIST_CERTIFICATE_P12` / `DIST_CERTIFICATE_PASSWORD` — Apple Distribution certificate
- `APPLE_TEAM_ID` — Vocify, Inc. team ID
- `ASC_KEY_P8` (base64-encoded) / `ASC_KEY_ID` / `ASC_ISSUER_ID` — App Store Connect API key for [`xcrun altool`](https://keith.github.io/xcode-man-pages/altool.1.html) uploads. The workflow `base64 -D` decodes `ASC_KEY_P8` before writing the `.p8` file.
- `IOS_PROVISIONING_PROFILE` — Production provisioning profile (App Store Distribution)
- `IOS_PROVISIONING_PROFILE_STAGING` / `_DEV` — Per-environment profiles
- `APPLE_APP_ID_PROD` / `_STAGING` / `_DEV` — Numeric App Store Connect app IDs (e.g. `123456789`), passed as `--apple-id` to [`xcrun altool --upload-package`](https://keith.github.io/xcode-man-pages/altool.7.html). Each environment has its own ASC app record with its own ID.
- `SLACK_WEBHOOK_URL` — Slack incoming webhook for `#build-alerts` notifications

## Structure

The iOS shell lives as a peer of `apps/web/`, not nested inside it.
`capacitor.config.ts` in `apps/web/` points at it via `ios.path: "../ios"`,
so `cd apps/web && bunx cap sync ios` writes generated files into
`apps/ios/`.

```
apps/
├── web/
│   ├── capacitor.config.ts           # Capacitor config (edit this); ios.path: "../ios"
│   ├── capacitor-shell/
│   │   └── index.html                # Placeholder webDir (unused at runtime)
│   └── package.json                  # @capacitor/* deps + ios:setup / ios:open scripts
└── ios/
    ├── .gitignore                    # Ignores Pods, DerivedData, xcuserdata,
    │                                 # generated capacitor.config.json, etc.
    ├── App/
    │   ├── App.xcodeproj/            # Open this in Xcode
    │   │   └── xcshareddata/xcschemes/  # Shared schemes for all 3 targets
    │   ├── App/
    │   │   ├── Config/               # xcconfig files (Base + per-target)
    │   │   ├── AppIcon.icon/         # Production icon (green)
    │   │   ├── AppIcon-Staging.icon/  # Staging icon (yellow)
    │   │   ├── AppIcon-Dev.icon/      # Dev icon (pink)
    │   │   ├── Assets.xcassets/      # Splash imageset lives here
    │   │   ├── Base.lproj/           # LaunchScreen.storyboard, Main.storyboard
    │   │   ├── AppDelegate.swift     # Universal Links + APNs token forwarding
    │   │   ├── MyViewController.swift  # CAPBridgeViewController subclass
    │   │   ├── NativeAuthPlugin.swift  # ASWebAuthenticationSession OIDC flow
    │   │   ├── NativeBiometricPlugin.swift # Face ID / Touch ID Keychain
    │   │   └── Info.plist
    │   └── CapApp-SPM/               # SPM local package: pulls in @capacitor/ios
    │                                 # and any Capacitor plugin native deps
    └── debug.xcconfig                # Sets CAPACITOR_DEBUG for Debug builds
```
