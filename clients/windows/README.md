# Vellum Assistant - Windows (Electron)

The Windows desktop client. Like `clients/macos`, this is an Electron shell
around the `clients/web` renderer: in dev it loads the Vite dev server (or
vel's edge proxy when `vel up` is running), and in packaged builds it serves a
bundled `resources/web-dist` over a privileged `app://` protocol.

## Layout

- `src/main/index.ts` boots the hardened shell (single-instance lock,
  per-environment `userData`, `app://` serving with path-traversal protection,
  local, paired, and platform request forwarding, paired-request frame-origin
  enforcement, CSP, a permission allowlist, and sandboxed `vellumapp://`
  serving) and then composes `src/main/features/*`.
- `src/main/features/*` and `src/preload/features/*` are capability modules
  installed through the registries in `@vellumai/electron-desktop`. Every
  `.ts` file in those directories is picked up automatically; a new capability
  is a new file, never an edit to `index.ts`.
- `src/preload/core-capabilities.ts` is the always-present core of
  `window.vellum`; `src/preload/bridge-parity.test.ts` holds the composed
  bridge to the full `VellumBridge` contract against the macOS preload.
- `native/Vellum.WindowsHelper` is the same-user, non-elevated JSON-RPC helper
  behind UI Automation observation, verified input, dictation, toasts, and
  text insertion (security model in `native/README.md`).
  `native/Vellum.PreviewHandler` is the Explorer preview and thumbnail handler
  for `.vellum` bundles.
- [`docs/parity-matrix.md`](docs/parity-matrix.md) maps every bridge key and
  main-process capability to its Windows module, its macOS counterpart, and the
  test or packaged smoke that covers it, and lists the macOS concepts with no
  Windows equivalent.

## Permissions and helper security

Windows has no Accessibility, Input Monitoring, or Automation permission
model; those rows are hidden on a Windows host. Microphone and screen access
report the Windows privacy settings, and `permissions.openSettings` deep-links
to the `ms-settings:` page for the kinds a user can change. The helper never
requests elevation: capabilities return unavailable when the target is
elevated or protected.

## Packaged CLI provisioning

Packaged Windows startup installs the bundled CLI runtime for the current user:

- The immutable payload is read from `resources/cli-runtime` and copied to
  `<Electron userData>/cli/<version>`.
- `<Electron userData>/cli/install-state.json` records the current runtime and
  one valid fallback. Reusing an older installed version preserves the prior
  current version as the fallback.
- A small owned launcher is installed under `%LOCALAPPDATA%\Vellum\bin` and
  delegates to the selected versioned runtime. Non-production channels use
  separate launcher directories. A launcher without the Vellum ownership
  marker is left untouched.
- Long-lived assistant, gateway, and worker executables remain in the
  versioned runtime. Provisioning and uninstall never replace or remove those
  executables while they may be running.
- The versioned runtime includes the web SPA used by the web client and remote
  web ingress.
- The launcher directory is added to `HKCU\Environment\Path`. The app broadcasts
  the environment change to the Windows shell after a successful write.
- Machine PATH entries are evaluated before user entries. If another
  `vellum.exe` wins resolution, startup records the launcher as shadowed.

`vellum retire` stages assistant data before archiving it. On Windows the
background archive uses PowerShell and the built-in `tar.exe`; other platforms
use the existing POSIX archive process.

## Automated backups

The packaged Windows client does not expose automated backup configuration yet.
The installed `vellum backup <name>` command creates an on-demand local export,
but the internal `assistant backup` command is not installed on the user PATH.

Windows has no implicit offsite destination. A future automated backup surface
must ask the user to select a OneDrive folder, external drive, or network
location explicitly. OneDrive environment variables are insufficient because
a machine can expose personal and organization-managed accounts at the same
time.

## Updates and troubleshooting

Packaged builds poll the channel-, platform-, and architecture-isolated feed
`https://storage.googleapis.com/vellum-ai-<env>-releases/win-electron/<arch>/`
through `electron-updater`, download in the background, and install on quit
(`src/main/auto-update.ts`). Main-process logs land in `vellum.log` under
`%APPDATA%\<product name>\logs`; the helper's state and restart action are on
`window.vellum.helper`, and the tray menu offers a restart.

## Development

```bash
bun run dev
```

Probes for `vel up` at `localhost:3000` and attaches to it, or falls back to
standalone mode (spawns `clients/web`'s Vite on :5173, shell only, no
backends). Scripts assume a POSIX shell; on Windows use Git Bash (or WSL).

To test local web changes against the deployed dev platform without starting
Vite or opening a local development port, run this from PowerShell:

```powershell
$env:VELLUM_ENVIRONMENT="dev"
$env:VELLUM_DEV_URL="https://dev-assistant.vellum.ai/assistant"
bun run dev:electron-local-web
```

This builds the local `clients/web` source, serves it from Electron's
`app://` origin, and forwards platform API requests to `dev-assistant`.

## Packaging

```bash
bun run pack                     # dev installer for testing on another machine
bun run pack --environment local # local-platform installer
bun run pack:debug               # dev installer with Chrome DevTools enabled
```

`pack` builds every bundled resource (`build:runtime`, `build:native-helper`,
`build:preview-handler`) before `electron-builder`, so the Explorer preview
handler DLL that `electron-builder.config.cjs` requires is always present.
The builder rebuilds the Electron main and preload entrypoints immediately
before collecting app files, including when it is invoked directly.

The default `dev` environment keeps an installed test build connected to the
deployed dev platform, including its login endpoint. Pass `--environment local`
only when a platform server is available at `localhost:8000`.

`build:runtime` bundles the Bun pinned in `.tool-versions`: the host `bun.exe`
is used when its sha256 matches `scripts/bun-release.ts`, otherwise the
matching GitHub release is downloaded and verified. Bump the pins there when
the Bun version changes.

`build:preview-handler` installs its manifest dependencies before invoking
MSBuild. It installs the manifest's pinned vcpkg baseline in the ignored
`clients/windows/.build-tools` directory and reuses it for future builds. This
keeps packaging independent of vcpkg copies exposed by Visual Studio,
environment variables, or `PATH`.

Local and CI packs are unsigned. `.github/workflows/windows-package-smoke.yaml`
runs the same steps per architecture, then install-, launch-, and
uninstall-tests the installer.

## Release

`.github/workflows/release-windows.yaml` is the reusable release: both
`dev-release.yaml` and `release.yml` call it with `{ environment, version }`
behind the `WINDOWS_{DEV,STAGING,PRODUCTION}_RELEASE_ENABLED` variables, so
each channel stays off until its variable is set. Per
architecture (x64 on `windows-2025`, arm64 on the `windows-11-vs2026-arm`
preview runner) it stamps the version, builds the helper, preview handler,
CLI runtime, and renderer, packages and signs through `electron-builder`,
verifies every manifest binary and the installer with
`Get-AuthenticodeSignature`, and publishes to the
`vellum-ai-<env>-releases/win-electron/<arch>/` feed: installer and blockmap
first, then the `<env>.yml` channel manifest.

The executable, installer, and uninstaller use the environment-specific icon
from `build-resources/icons/<environment>/icon.ico`, matching the local, dev,
staging, and production desktop identities.

Signing is provider-neutral and an explicit gate on each GitHub environment
(`electron-builder.config.cjs`, `WINDOWS_SIGNING_PROVIDER`):

- `pfx`: `WINDOWS_SIGNING_PFX_BASE64` + `WINDOWS_SIGNING_PFX_PASSWORD` secrets.
- `azure-trusted-signing`: `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
  `AZURE_CLIENT_SECRET` secrets plus `AZURE_TRUSTED_SIGNING_ENDPOINT`,
  `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`, and
  `WINDOWS_SIGNING_PUBLISHER_NAME` variables.
- `command`: a `WINDOWS_SIGN_COMMAND` secret holding any signing CLI
  invocation with a `{file}` placeholder, plus `WINDOWS_SIGNING_PUBLISHER_NAME`
  so the updater can verify downloaded installers.

Production also requires `SENTRY_DSN_WINDOWS` and `SENTRY_AUTH_TOKEN` secrets
plus the `SENTRY_PROJECT_WINDOWS` variable. The DSN serves both the main
process and the renderer (baked in as `VITE_SENTRY_DSN_WINDOWS`, which the
shared web bundle selects on a Windows host), and the token and project enable
renderer source-map uploads. Non-production builds
warn and continue when Sentry is not configured. `WINDOWS_SIGNING_TIMESTAMP_URL`
is optional. Unsigned Windows releases are never published.

## Checks

```bash
bun run typecheck
bun run test:ci
```
