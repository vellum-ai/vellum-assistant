# Capacitor iOS shell

Native iOS wrapper around `dev-assistant.vellum.ai` built with [Capacitor](https://capacitorjs.com/).
This is _not_ a port of the web app — it's a thin `WKWebView` shell in
`server.url` mode that loads the live web app directly over HTTPS.

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
in `release-ios.yaml`. **Until the deployment cutover, the release
pipeline still runs from `vellum-assistant-platform/web/ios/`** — the
workflow migration is a separate follow-up.

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

## How it's set up

> **Web-side conventions for iOS code paths**: any change to the web app
> that might run inside this WKWebView shell needs to follow the patterns
> in [`apps/web/docs/CAPACITOR.md`](../web/docs/CAPACITOR.md) — Capacitor plugin
> lazy imports, native auth, deep links, autogrowing textareas,
> streaming watchdogs, OS permission UI, etc.

### `server.url` mode, not static export

`capacitor.config.ts` sets `server.url` to
`https://dev-assistant.vellum.ai/assistant` by default; setting
`VELLUM_ENVIRONMENT=production` before `bunx cap sync ios` bakes
`https://www.vellum.ai/assistant` instead — that's how TestFlight /
App Store builds get pointed at prod. The `/assistant` suffix is
deliberate — booting on the bare host lands on the marketing page,
whose CTA redirects to `www.vellum.ai/assistant` and bounces non-prod
shells off their own host. At launch, the
WebView navigates straight to that URL — the bundled
`capacitor-shell/index.html` is just a placeholder Capacitor requires
for `webDir`, never actually shown.

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
| App Staging | `.staging` | Vellum Staging | Yellow | `staging-assistant.vellum.ai` |
| App Dev | `.dev` | Vellum Dev | Pink | `dev-assistant.vellum.ai` |

Build settings shared across all three targets live in
`App/App/Config/Base.xcconfig`. Per-target overrides (bundle ID, display
name, icon) live in `App/App/Config/App-<env>.xcconfig`. Debug-specific
flags (`OTHER_SWIFT_FLAGS`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS`) live
inline in `App/project.yml` under the `AppEnvironment` template.

### App icon + launch screen

- `App/App/AppIcon.icon/` is an Icon Composer bundle (green background +
  white "V"). It uses the same visual design as the macOS app icon
  source SVG ([`vellum-assistant/clients/macos/build-resources/icons/production/Assets/white-V.svg`](https://github.com/vellum-ai/vellum-assistant/blob/main/clients/macos/build-resources/icons/production/Assets/white-V.svg)),
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
  `https://dev-assistant.vellum.ai` with `cleartext: false`.

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
- [ ] WebView loads `dev-assistant.vellum.ai` and you can sign in
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

> **Migration note**: this directory is the new home for the Capacitor
> iOS shell. Until the deployment cutover, the actual release pipeline
> still runs from `vellum-assistant-platform/web/ios/` — that's the
> copy that gets built and shipped to TestFlight. The description below
> documents the existing pipeline as it lives in the platform repo;
> pointing it at this directory is a follow-up task.

iOS builds are triggered **cross-repo** from
[`vellum-assistant`](https://github.com/vellum-ai/vellum-assistant) via
GitHub Actions
[`repository_dispatch`](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#repository_dispatch)
events. This keeps iOS releases in sync with the macOS release pipeline
without duplicating version/environment logic.

### How it works

There are three release tracks, each originating in `vellum-assistant`:

**Dev release** — `dev-release.yaml` runs hourly (cron) or via manual
`workflow_dispatch`. It builds from `main`, and the `dispatch-ios-release`
job fires an `ios-release` event with `environment=dev`.

**Staging release** — `/release` (slash command) runs `create-release-branch.yml`,
which creates a `release/v*` branch. Pushing to that branch triggers
`release.yml` with `is_staging=true`, and the `dispatch-ios-release` job
fires an `ios-release` event with `environment=staging`. A manual
`workflow_dispatch` of `release.yml` from `main` also produces a staging release.

**Production release** — A manual `workflow_dispatch` of `release.yml` on
the `release/v*` branch (not `main`) sets `is_staging=false`, and the
`dispatch-ios-release` job fires an `ios-release` event with
`environment=production`.

```
vellum-assistant                           vellum-assistant-platform
────────────────                           ────────────────────────
dev-release.yaml (hourly / manual)         release-ios.yaml
  └─ dispatch-ios-release ──────────────►    repository_dispatch: ios-release
     environment=dev                           └─ builds App Dev → TestFlight

release.yml (push to release/v* or         release-ios.yaml
             manual dispatch from main)
  └─ dispatch-ios-release ──────────────►    repository_dispatch: ios-release
     environment=staging                       └─ builds App Staging → TestFlight

release.yml (manual dispatch on            release-ios.yaml
             release/v* branch)
  └─ dispatch-ios-release ──────────────►    repository_dispatch: ios-release
     environment=production                    └─ builds App → TestFlight

```

### Workflows (currently in `vellum-assistant-platform`)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `release-ios.yaml` | `repository_dispatch` from vellum-assistant | Automated release builds (dev/staging/production) |

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

The workflow calls the repo's reusable
[`slack-build-alert.yml`](.github/workflows/slack-build-alert.yml)
workflow on completion (`if: always()`), matching the pattern used by
`main-ci-cd.yaml`, `cd-vembda-assistant-server.yml`, and the Terraform
apply workflows. Failures surface in `#build-alerts` via
`SLACK_WEBHOOK_URL`.

### Why no `bun run build` before `cap sync`

The Capacitor `webDir` is `capacitor-shell/` — a static placeholder
containing only a "Loading…" HTML page. The app uses
[`server.url` mode](https://capacitorjs.com/docs/guides/server-url):
at runtime, `WKWebView` loads the live web app over HTTPS. No web
assets are bundled in the IPA, so no build step is needed.

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
in this repo. The iOS release is a single combined workflow (not
separate CI/CD files) because it's an atomic operation triggered by
`repository_dispatch` — there's no separate CI gate. Signing steps are
not extracted into a reusable workflow because it's the only iOS
workflow.

### Secrets (GitHub Actions)

All iOS signing secrets are stored as GitHub Actions secrets:

- `DIST_CERTIFICATE_P12` / `DIST_CERTIFICATE_PASSWORD` — Apple Distribution certificate
- `APPLE_TEAM_ID` — Vocify, Inc. team ID
- `ASC_KEY_P8` (base64-encoded) / `ASC_KEY_ID` / `ASC_ISSUER_ID` — App Store Connect API key for [`xcrun altool`](https://keith.github.io/xcode-man-pages/altool.1.html) uploads. The workflow `base64 -D` decodes `ASC_KEY_P8` before writing the `.p8` file.
- `IOS_PROVISIONING_PROFILE` — Production provisioning profile (App Store Distribution)
- `IOS_PROVISIONING_PROFILE_STAGING` / `_DEV` — Per-environment profiles
- `APPLE_APP_ID_PROD` / `_STAGING` / `_DEV` — Numeric App Store Connect app IDs (e.g. `6759934423`), passed as `--apple-id` to [`xcrun altool --upload-package`](https://keith.github.io/xcode-man-pages/altool.7.html). Each environment has its own ASC app record with its own ID.
- `SLACK_WEBHOOK_URL` — Slack incoming webhook for `#build-alerts` notifications

### Cross-repo auth

The dispatch uses a GitHub App token generated from `VELLUM_AUTOMATION_GITHUB_APP_ID`
/ `VELLUM_AUTOMATION_GITHUB_PRIVATE_KEY` (stored in `vellum-assistant`), scoped to
`vellum-assistant-platform` via
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).

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
