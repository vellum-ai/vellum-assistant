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
| `production` | `ai.vellum.assistant` | Vellum | `vellum-assistant` | `www.vellum.ai` |
| `staging` | `ai.vellum.assistant.staging` | Vellum Staging | `vellum-assistant-staging` | `staging-assistant.vellum.ai` |
| `dev` | `ai.vellum.assistant.dev` | Vellum Dev | `vellum-assistant-dev` | `dev-assistant.vellum.ai` |

For local development, pick the `devDebug` variant in Android Studio. If you
sync a different `VELLUM_ENVIRONMENT`, build the matching flavor so the WebView
origin and native auth host agree.

Launcher and splash colors also distinguish production, staging, and dev
installs.

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

## Voice Audio Focus

The `VoiceAudioSession` plugin requests transient voice-communication audio focus while a live voice session is active. Calls and competing media produce the same interruption payload used by iOS.
Wired and Bluetooth changes are nonfatal, duckable audio does not end voice, and focus is released when voice ends or the activity closes so interrupted media can resume.

Microphone capture and the voice socket remain in the foreground WebView. No microphone foreground service is used.
Physical-device background validation has not been completed, so app switching and screen locking are not supported as background voice behavior.

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
    │       ├── java/ai/vellum/assistant/
    │       │   ├── ConnectDeepLink.java
    │       │   ├── MainActivity.java
    │       │   ├── NativeAuthPlugin.java
    │       │   ├── NativeBiometricPlugin.java
    │       │   ├── BiometricTokenStore.java
    │       │   ├── SelfHostedServer.java
    │       │   ├── VoiceAudioSessionPlugin.java
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

CI runs JVM tests once, then syncs, lints, and bundles every flavor.

## Versions and Signing

`app/build.gradle` reads release values from Gradle properties or matching
environment variables:

| Input | Purpose |
|-------|---------|
| `VELLUM_ANDROID_VERSION_CODE` | Positive, monotonically increasing Play build number |
| `VELLUM_ANDROID_VERSION_NAME` | User-visible version, such as `1.2.3` |
| `VELLUM_ANDROID_KEYSTORE_PATH` | Path to the upload keystore |
| `VELLUM_ANDROID_KEYSTORE_PASSWORD` | Upload keystore password |
| `VELLUM_ANDROID_KEY_ALIAS` | Upload key alias |
| `VELLUM_ANDROID_KEY_PASSWORD` | Upload key password |
| `VELLUM_ANDROID_REQUIRE_SIGNING` | Set to `true` to reject an unsigned bundle |

Local debug builds and CI do not need signing credentials. A release build is
unsigned when no signing input is supplied. Supplying only part of the signing
set fails during Gradle configuration so a release cannot silently use the
wrong identity.

Release builds enable resource shrinking and R8 optimization. Capacitor plugin
annotations and methods are retained by `app/proguard-rules.pro`.

## Google Play Internal Releases

`.github/workflows/release-android.yaml` is the reusable Android release
workflow. It builds a signed AAB, retains it as an artifact, and uploads it to
the matching Play internal track. Production-track promotion remains manual.

Configure these environment-scoped GitHub secrets independently for `dev`,
`staging`, and `production`:

| Secret | Format |
|--------|--------|
| `ANDROID_UPLOAD_KEYSTORE_B64` | Base64-encoded Play upload keystore |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Upload keystore password |
| `ANDROID_UPLOAD_KEY_ALIAS` | Upload key alias |
| `ANDROID_UPLOAD_KEY_PASSWORD` | Upload key password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Raw Play service account JSON |

Never commit the keystore, credentials, or decoded secret material. The
workflow removes restored signing files even when a build fails.

After all prerequisites and environment secrets are ready, set the repository
variable `ANDROID_RELEASE_ENABLED` to `true`. Until then, both orchestrators
skip Android distribution so existing releases remain unaffected.

### Manual Play Prerequisites

Complete the following setup before enabling internal-track uploads:

1. Create Play Console apps for `ai.vellum.assistant`,
   `ai.vellum.assistant.staging`, and
   `ai.vellum.assistant.dev`.
2. Enable Play App Signing for each app and create one controlled upload key.
3. Upload and roll out one signed AAB to each app's internal track manually.
   Google Play requires this initial release before the Publisher API can
   upload a completed release.
4. Grant the release service account permission to publish to each app's
   internal track, then configure the environment-scoped secrets above.
5. Complete each Play listing, privacy policy, Data Safety form, content rating,
   and the declarations required for microphone permissions.

Before wider rollout, test the internal-track AAB on a physical device and
verify its identity, web origin, authentication, keyboard, and file sharing.
