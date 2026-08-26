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

The launcher icon is the `quirky` eye pair from the avatar library in
`assistant/src/avatar/character-components.ts`, the same design the iOS app
icon uses. The six paths in `res/drawable/ic_launcher_foreground.xml` and in
the pre-adaptive `res/mipmap-anydpi/ic_launcher*.xml` fallbacks are copied
verbatim from that table and only repositioned by a VectorDrawable `<group>`,
so the icon stays in sync with the in-app avatars. Launcher background colors
distinguish production (`#4C9B50`, the avatar palette green), staging, and dev
installs.

The launch screen follows the saved app appearance, falling back to the Android
light or dark setting until the web app has stored a preference. Android's app
night mode keeps the OS splash and native overlay on the same theme. Android 11
and older skip the OS preview window so the themed native overlay is the first
app frame.

## HTTPS App Links

Each flavor claims only its own web host. The verified routes are the app root,
pairing, conversations, voice settings, OAuth completion, and billing pages.
Other paths stay in the browser. Incoming links navigate the existing WebView
with their query string and fragment intact.

A shell paired to a self-hosted assistant keeps its current server when a
Vellum Cloud App Link arrives. App Links do not interrupt pairing or switch a
self-hosted WebView to Vellum Cloud.

Android verifies a claim only after the matching host serves
`/.well-known/assetlinks.json` with HTTP 200, `application/json`, and no
redirect. Each statement must use the application ID in the Build Variants
table and real SHA-256 fingerprints for every certificate that signs that
flavor. Play App Signing fingerprints must come from Play Console. Do not use
an upload-certificate fingerprint as a substitute.

The existing custom schemes remain supported for native auth, pairing, billing
completion, and voice commands. HTTPS App Links are additive.

After the Digital Asset Links file is deployed, install the matching build on
a physical device and check verification with:

```bash
adb shell pm get-app-links ai.vellum.assistant
adb shell am start -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d 'https://www.vellum.ai/assistant/conversations/conv-xyz?message=message-123#reply'
```

Use the suffixed application ID and matching host when checking staging or dev.

## Billing

The Android shell renders the same billing surfaces as iOS (plan card, plans
takeover, billing settings) but sells nothing in-app: there is no Google Play
Billing integration, and every purchase CTA opens the matching page on the
hosted web app in the system browser instead of starting a checkout inside the
WebView. The handoff lives in
`clients/web/src/lib/billing/android-billing-handoff.ts`; it goes through the
Capacitor Browser plugin because a plain navigation would stay in the WebView
and a bare VIEW intent would bounce straight back via the verified App Links
above. Because the purchase runs on the hosted web app in a plain browser
context, Stripe returns to the hosted web page there rather than through the
custom-scheme `billing/checkout-complete` deep link; the manifest still claims
that scheme for checkouts launched from a native context.

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
Build Variants table. An optional `name=<label>` parameter supplies a
user-facing label; the value is trimmed and a blank label is treated as
absent. Scanning a connect link switches the native shell to the validated
server, opens `<server>/assistant/pair`, and keeps an existing server path
prefix intact. Cold and warm app launches use the same route.

A server the list does not already hold joins it, with its label, as soon as
the link is scanned, matching iOS, so the chooser can still offer it when the
pairing page never loads. What a scan alone cannot claim is deferred until that
page loads: the active slot, so an unreachable server never displaces the one
already working, and any label a server is already remembered under, so an
unpaired link can fill in a missing name but cannot rewrite one an earlier
pairing established. The one-time device code is kept out of app preferences
and the generated Capacitor configuration. HTTPS is required except for
`localhost`, `127.0.0.1`, and the Android emulator host alias `10.0.2.2`. Use
`adb reverse` when a physical development device needs to reach a service
through `localhost`.

Paired servers accumulate in a remembered list, stored as JSON `{name?, url}`
entries in the same `self_hosted_server` SharedPreferences file as the active
server. Entries are keyed by the canonical URL the web chooser's
`normalizeOriginUrl` also computes (scheme-default ports collapse, trailing
slashes are stripped, and percent-escape casing and interior duplicate
separators are preserved), so both sides agree on which strings mean the same
HTTPS server. The cleartext development hosts are the exception: the web
normalizer rejects every non-HTTPS URL, so an `http://localhost`-style server
stays in the native list and remains switchable through a connect link, but
never surfaces as a chooser card.

The web assistant chooser is the management surface. The `SelfHostedServers`
Capacitor plugin exposes the list to it and handles switch and forget
(`list`/`add`/`remove`/`switchTo`/`switchToPath`). Switching recreates the
activity so Capacitor starts on a configuration rebuilt around the new
`server.url`; that configuration loads `<base>/assistant`, so a hosting path
prefix survives the ingress redirect that would otherwise drop it. Forgetting
the active server returns the shell to Vellum Cloud the same way.

If Android terminates the app before the pairing page loads, scan the connect
link again. The shell intentionally does not save the one-time code for process
restoration.

If a saved or newly scanned server cannot load, whether the connection is
refused outright or a tunnel provider answers on the server's behalf with its
own error page, the native recovery dialog offers Retry or Choose Assistant.
Choose Assistant clears the active slot and recreates onto the Vellum Cloud
chooser, which lists every remembered server including the one that just
failed. A failed new server is never promoted over the last server that loaded
successfully.

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

The same lifecycle starts `VoiceModeService` while the app is visible and the
microphone permission is active. This microphone foreground service keeps the
WebView-owned capture, playback, and voice socket running when the screen locks
or the user switches apps. It stops with audio focus when voice ends, fails, or
the activity is torn down.

## Voice Status and Launch Surfaces

`VoiceLiveActivity` mirrors the active web voice session into the foreground
service's one stable ongoing notification. Connecting, listening,
transcribing/thinking, and speaking update that notification in place. Ending,
failure, app reset, activity teardown, and process recovery remove it. Tapping
it sends the shared
`<scheme>://voice?mode=resume` command, whose web consumer restores the room for
the conversation that owns the live session. It never creates a second voice
session.

On Android 16, the notification requests promoted Live Update treatment only
when the system reports that promoted notifications are enabled and the built
notification is eligible. Every supported Android version uses the required
foreground-service notification as the baseline. Notification permission is
never requested by the plugin, so voice continues normally when Android hides
the notification from the notification drawer.

The launcher exposes New chat and Start voice shortcuts. Users may also add the
Start voice Quick Settings tile. The tile exists only while Android invokes its
`TileService`; tapping it opens the app and hands the same start command to the
web layer. It does not capture audio or retain a background process.
Gradle renders `app/src/main/shortcuts.xml` with an explicit target for each
flavor, so side-by-side installations cannot receive one another's shortcuts.

The only registered Google Assistant App Action is the official
`OPEN_APP_FEATURE` built-in intent, with New chat and Voice mode as its inline
inventory. Android has no supported built-in intent whose semantics match
asking Vellum a free-form question or managing a live voice session, so those
Assistant surfaces are intentionally not advertised.

Physical-device validation is still required for Android 16 promotion,
notification permission changes, launcher shortcut ingestion, Quick Settings
tile addition, background voice, lock-screen notification taps, and warm/cold
voice launches.

## Native notifications

Android registers FCM on `vellum-alerts`, renders foreground pushes once, and handles background pushes and taps.
FCM needs Play services and untracked `google-services.json`; failures retry on resume.

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
    │       │   ├── Attribution.java
    │       │   ├── ConnectDeepLink.java
    │       │   ├── InstallReferrerPlugin.java
    │       │   ├── MainActivity.java
    │       │   ├── NativeAuthPlugin.java
    │       │   ├── NativeBiometricPlugin.java
    │       │   ├── NativeLaunchScreenPlugin.java
    │       │   ├── BiometricTokenStore.java
    │       │   ├── SelfHostedServer.java
    │       │   ├── SelfHostedServersPlugin.java
    │       │   ├── VoiceAudioSessionPlugin.java
    │       │   ├── VoiceDeepLink.java
    │       │   ├── VoiceLiveActivityPlugin.java
    │       │   ├── VoiceModeService.java
    │       │   ├── VoiceQuickSettingsTileService.java
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
the matching Play internal track through the Android Publisher API. The
publisher uses Google's official Android Publisher client and repository-owned
code, not an external Play publishing action. Production-track promotion
remains manual.
When Firebase configuration is available, the workflow validates that it
matches the selected flavor before including it in the build.

Configure these shared repository-level GitHub secrets once:

| Secret | Format |
|--------|--------|
| `ANDROID_UPLOAD_KEYSTORE_B64` | Base64-encoded Play upload keystore |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Upload keystore password |
| `ANDROID_UPLOAD_KEY_ALIAS` | Upload key alias |
| `ANDROID_UPLOAD_KEY_PASSWORD` | Upload key password |

Configure the optional `ANDROID_FIREBASE_CONFIG_B64` secret independently on
the `dev`, `staging`, and `production` GitHub environments. Each value must be
the base64-encoded `google-services.json` for that environment's package.

The publish job authenticates without a JSON key by using the existing
environment-scoped `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`
GitHub variables. `GCP_SERVICE_ACCOUNT` must match the environment's
`assistant_deploy_service_account_email` Terraform output.

Never commit Firebase configuration, the keystore, or decoded secret material.
The workflow removes restored files even when a build fails.

`ANDROID_FIREBASE_CONFIG_B64` remains optional so signing and internal
distribution do not depend on push setup. When it is absent, the workflow emits
a warning and the resulting AAB has no native push support. When it is present,
malformed base64, invalid JSON, or a package mismatch fails the build.

After completing the prerequisites and GitHub configuration, enable Android
distribution independently with these repository variables:

| Variable | Release workflow |
|----------|------------------|
| `ANDROID_DEV_RELEASE_ENABLED` | Dev releases |
| `ANDROID_STAGING_RELEASE_ENABLED` | Staging releases |
| `ANDROID_PRODUCTION_RELEASE_ENABLED` | Production releases |

Set only `ANDROID_DEV_RELEASE_ENABLED` to `true` to test the dev app on its Play
internal track. Leave the staging and production variables unset or set to
`false` until those apps are ready. A missing or non-`true` variable skips the
matching Android distribution job. Manually dispatch the **Dev Release**
workflow to run the dev release immediately instead of waiting for its hourly
schedule.

### Manual Play Prerequisites

Complete the following setup before enabling internal-track uploads:

1. Apply the platform Terraform stacks that enable the Android Publisher API
   in the dev, staging, and production GCP projects.
2. Create Play Console apps for `ai.vellum.assistant`,
   `ai.vellum.assistant.staging`, and
   `ai.vellum.assistant.dev`.
3. Enable Play App Signing for each app and create one controlled upload key.
4. Upload and roll out one signed AAB to each app's internal track manually.
   Google Play requires this initial release before the Publisher API can
   upload a completed release.
5. In Play Console, grant each environment's `GCP_SERVICE_ACCOUNT` access only
   to its matching app, with **View app information (read-only)** and
   **Release apps to testing tracks**. Do not grant production publishing.
6. Configure the repository and environment secrets above.
7. Complete each Play listing, privacy policy, Data Safety form, content rating,
   and the declarations required for microphone and camera permissions.

Before wider rollout, test the internal-track AAB on a physical device and
verify its identity, web origin, authentication, keyboard, and file sharing.

### Manual Firebase Prerequisites

Create a separate Firebase Android app in each matching Firebase project:

| GitHub environment | Android package ID |
|--------------------|--------------------|
| `production` | `ai.vellum.assistant` |
| `staging` | `ai.vellum.assistant.staging` |
| `dev` | `ai.vellum.assistant.dev` |

For each app, download its `google-services.json`, encode it without line
breaks, and save the result as the `ANDROID_FIREBASE_CONFIG_B64` secret on the
matching GitHub Environment:

```bash
base64 < google-services.json | tr -d '\n'
```

Do not reuse a Firebase file across environments. After configuring the
secret, verify push registration and notification delivery from an
internal-track install on a physical device.
