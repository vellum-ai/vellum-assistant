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

The launcher and splash colors distinguish installed environments:

| Flavor | Launcher and splash color |
|--------|---------------------------|
| `production` | Vellum green |
| `staging` | Orange |
| `dev` | Blue |

Adaptive, round, and monochrome launcher icons are included. The Android theme
handles transparent system bars, display cutouts, rotation, and keyboard
resizing. Target SDK 36 supplies platform edge-to-edge behavior on Android 15
and later without disabling `adjustResize` on older devices.

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

CI syncs each environment, runs its JVM tests and lint checks, and produces an
unsigned release AAB for every flavor. Unsigned release bundles are build
artifacts only and cannot be uploaded to Play.

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

To make a local signed bundle, sync the matching environment and pass the
complete signing set without saving it in the repository. Export the two
password variables in your shell before running the Gradle command.

```bash
cd clients/web
VELLUM_ENVIRONMENT=dev bun run android:sync

cd ../android
VELLUM_ANDROID_VERSION_CODE=123 \
VELLUM_ANDROID_VERSION_NAME=1.2.3 \
VELLUM_ANDROID_REQUIRE_SIGNING=true \
VELLUM_ANDROID_KEYSTORE_PATH=/absolute/path/upload.jks \
VELLUM_ANDROID_KEY_ALIAS='<key-alias>' \
./gradlew :app:bundleDevRelease
```

Release builds enable resource shrinking and R8 optimization. Capacitor plugin
annotations and methods are retained by `app/proguard-rules.pro`.

## Google Play Internal Releases

`.github/workflows/release-android.yaml` is the reusable Android release
workflow. It selects the flavor and package from its environment input, checks
that the injected Firebase file names the expected package, restores the upload
key in a temporary path, builds a signed AAB, and retains the AAB as an
artifact. When `upload_to_play` is enabled, it uploads only to that app's Play
`internal` track.

The dev and standard release orchestrators call this workflow. A production
flavor build still lands on the internal track. Promoting it to a production
track is a separate manual action and is not performed by GitHub Actions.

Configure these environment-scoped GitHub secrets independently for `dev`,
`staging`, and `production`:

| Secret | Format |
|--------|--------|
| `ANDROID_FIREBASE_CONFIG_B64` | Base64-encoded `google-services.json` for the environment's package |
| `ANDROID_UPLOAD_KEYSTORE_B64` | Base64-encoded Play upload keystore |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Upload keystore password |
| `ANDROID_UPLOAD_KEY_ALIAS` | Upload key alias |
| `ANDROID_UPLOAD_KEY_PASSWORD` | Upload key password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Raw Play service account JSON |

Never commit the Firebase files, keystore, credentials, or decoded secret
material. The workflow removes restored files even when a build fails.

After all prerequisites and environment secrets are ready, set the repository
variable `ANDROID_RELEASE_ENABLED` to `true`. Until then, both orchestrators
skip Android distribution so existing releases remain unaffected.

### Manual Play and Firebase Prerequisites

Complete the following setup before enabling internal-track uploads:

1. Create Play Console apps for `ai.vocify.vellumassistant`,
   `ai.vocify.vellumassistant.staging`, and
   `ai.vocify.vellumassistant.dev`.
2. Enable Play App Signing for each app and create one controlled upload key.
3. Grant the release service account permission to publish to each app's
   internal track, then configure the environment-scoped secrets above.
4. Create matching Firebase Android apps and download a separate
   `google-services.json` for every package ID.
5. Record each Play signing SHA-256 certificate fingerprint for the Digital
   Asset Links rollout. The upload key fingerprint is not interchangeable with
   the Play signing fingerprint.
6. Create internal tester groups and verify that testers can install all three
   package IDs side by side.
7. Complete each Play listing, privacy policy, Data Safety form, content rating,
   and the declarations required for microphone and notification permissions.
8. Review app access instructions and release notes before any wider rollout.

After setup, verify an internal-track install on a physical device. Confirm the
package ID, display name, icon color, splash color, web origin, authentication
callback, Firebase project, version name, and version code all match the chosen
environment. On Android 11 through 14, rotate the device and open the keyboard
to confirm that the composer remains visible. Smoke-test authentication, push
registration, file sharing, and the file provider from the shrunk release AAB.
