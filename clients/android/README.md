# Capacitor Android Shell

Native Android wrapper built with [Capacitor](https://capacitorjs.com/). Like
the iOS shell, this is a thin WebView app in `server.url` mode that loads the
live web app over HTTPS.

## Web Content Delivery

The Android app loads the web UI from the environment-specific web origin:

| Environment | Server |
|-------------|--------|
| `production` | `https://www.vellum.ai/assistant` |
| `staging` | `https://staging-assistant.vellum.ai/assistant` |
| `dev` | `https://dev-assistant.vellum.ai/assistant` |

Set `VELLUM_ENVIRONMENT` before `bunx cap sync android` to bake the matching
URL into `app/src/main/assets/capacitor.config.json`. The default is `dev`.
No web assets are bundled beyond the placeholder `capacitor-shell/` page.

## First-Time Setup

From `clients/web/`:

```bash
bun install
bun run android:open
```

`android:open` runs `cap sync android` and opens the project in Android Studio.
Use `bun run android:sync` when you only need to refresh native generated files.

## Build Variants

Gradle defines three product flavors so dev, staging, and production can have
separate package IDs, display names, auth callback schemes, and allowed auth
hosts.

| Flavor | Application ID | Display Name | Auth Scheme | Auth Host |
|--------|----------------|--------------|-------------|-----------|
| `production` | `ai.vocify.vellumassistant` | Vellum | `vellum-assistant` | `www.vellum.ai` |
| `staging` | `ai.vocify.vellumassistant.staging` | Vellum Staging | `vellum-assistant-staging` | `staging-assistant.vellum.ai` |
| `dev` | `ai.vocify.vellumassistant.dev` | Vellum Dev | `vellum-assistant-dev` | `dev-assistant.vellum.ai` |

For local development, pick the `devDebug` variant in Android Studio. If you
sync a different `VELLUM_ENVIRONMENT`, build the matching flavor so the WebView
origin and native auth host agree.

## Native Auth

The `NativeAuth` Capacitor plugin opens WorkOS AuthKit in the system browser,
receives the custom-scheme callback, performs the PKCE code exchange, and
returns a platform session token to the web app. The web app installs the
session cookie and navigates to the requested destination.

The plugin rejects auth attempts whose `baseURL` host does not match the
current Gradle flavor's `vellum_auth_host` resource. This mirrors the iOS
target-level host guard and prevents a non-production shell from driving
production SSO.

## Structure

```
clients/
├── web/
│   ├── capacitor.config.ts       # Shared Capacitor config; android.path: "../android"
│   ├── capacitor-shell/          # Placeholder webDir
│   └── package.json              # android:sync / android:open scripts
└── android/
    ├── app/
    │   ├── build.gradle          # Product flavors and Capacitor app module
    │   └── src/main/
    │       ├── AndroidManifest.xml
    │       ├── java/ai/vocify/vellumassistant/
    │       │   ├── MainActivity.java
    │       │   ├── NativeAuthPlugin.java
    │       │   └── WorkOSAuth.java
    │       └── res/              # Vellum icon, splash, colors, file paths
    ├── build.gradle
    ├── settings.gradle
    └── variables.gradle
```

## Common Tasks

### Sync Android After Editing Capacitor Config

```bash
cd clients/web
VELLUM_ENVIRONMENT=dev bun run android:sync
```

### Build From the Command Line

```bash
cd clients/android
./gradlew :app:assembleDevDebug
```

CI runs the same dev debug build after syncing from `clients/web/`.
