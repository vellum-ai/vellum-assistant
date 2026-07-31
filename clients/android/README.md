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
bun run android:run
```

`android:run` syncs the dev configuration, builds `devDebug`, starts or reuses
a connected device or available emulator, installs the app, and launches it.
If no emulator exists, the command installs the API 36 system image and creates
`vellum-api-36`. On macOS it installs missing Android command-line tools through
Homebrew. The first run may prompt you to accept Android SDK licenses.
Use `bun run android:open` to work in Android Studio or `bun run android:sync`
when you only need to refresh native generated files.

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

## Self-Hosted Assistants

Android accepts environment-specific connect links in this form:

```text
vellum-assistant-dev://connect?url=https%3A%2F%2Fassistant.example.com&code=device-code
```

The production and staging builds use their matching auth schemes from the
Build Variants table. Scanning a connect link switches the native shell to the
validated server, opens `<server>/assistant/pair`, and keeps an existing server
path prefix intact. Cold and warm app launches use the same route.

Only the validated server base is saved after the pairing page loads. The
one-time device code is kept out of app preferences and the generated
Capacitor configuration. HTTPS is required except for `localhost`, `127.0.0.1`,
and the Android emulator host alias `10.0.2.2`. Use `adb reverse` when a physical
development device needs to reach a service through `localhost`.

If Android terminates the app before the pairing page loads, scan the connect
link again. The shell intentionally does not save the one-time code for process
restoration.

If a saved or newly scanned server cannot load, the native recovery dialog can
retry it or clear the saved server and return to Vellum Cloud. A failed new
server is never promoted over the last server that loaded successfully.

## Biometric Session Recovery

The `NativeBiometric` plugin implements the same Capacitor contract as iOS.
It protects server-keyed session tokens with Android Keystore AES-GCM keys and
requires an enrolled strong biometric to store or retrieve a token. Deletion
removes the ciphertext and key immediately so sign-out cannot retain recovery
material. Enrollment changes invalidate the key and remove unusable
ciphertext.

Stored preferences contain only an encrypted payload and IV. Android backups
are disabled, and token values are never written to logs or crash metadata.

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
    │       │   ├── ConnectDeepLink.java
    │       │   ├── MainActivity.java
    │       │   ├── NativeAuthPlugin.java
    │       │   ├── NativeBiometricPlugin.java
    │       │   ├── BiometricTokenStore.java
    │       │   ├── SelfHostedServer.java
    │       │   └── WorkOSAuth.java
    │       └── res/              # Vellum icon, splash, colors, file paths
    ├── build.gradle
    ├── settings.gradle
    └── variables.gradle
```

## Common Tasks

### Run Android From the Command Line

```bash
cd clients/web
bun run android:run
```

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
