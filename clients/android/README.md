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

The launch screen uses a centered white Vellum wordmark on black. The Android
12 system splash stays visible until the native loading overlay is attached.
Both surfaces share the same drawable and colors. Android 11 and older skip the
OS preview window so the native overlay is the first app frame.

## Launcher Icons

The default launcher icon is the `quirky` eye pair from the avatar library in
`packages/avatar-catalog`, the same design the iOS app icon uses. The six paths
in `app/src/main/res/drawable/ic_launcher_foreground.xml` and in the
pre-adaptive `app/src/main/res/mipmap-anydpi/ic_launcher*.xml` fallbacks are
copied verbatim from that table and only repositioned by a VectorDrawable
`<group>`, so the icon stays in sync with the in-app avatars.

Each flavor's `launcher_background` in
`app/src/<flavor>/res/values/colors.xml` distinguishes the installs: production
`#4C9B50` (the avatar palette green), staging `#E9C91A`, and dev `#FF88C9`.
Those three are the shared cross-platform standard: a flavor and the iOS
`AppIcon-*.icon` bundle for the same environment sit on the same color, which
the web app names once as `APP_ICON_GROUNDS`. Change one and change the rest
with it.

### Alternate Icons

A user picks an eyes-on-color launcher icon in the web app under
Settings -> General -> Preferences -> App icon
(`clients/web/src/domains/settings/components/app-icon-modal.tsx`), gated on the
dark `android-avatar-app-icon` flag. Every combination ships: 9 eye styles by 6
colors, so 54 alternates.

`clients/ios/scripts/generate-android-avatar-icons.ts` writes all of them from
the avatar catalog as vector XML rather than rasterized PNGs. Edit the script,
not the files. Regenerate the committed state with
`bun clients/ios/scripts/generate-android-avatar-icons.ts`, add `--pilot` to cut
a local run down to a 12-set slice while iterating, and verify with
`cd clients/ios && bun test scripts/__tests__/android-avatar-icons.test.ts`.
Measuring where an eye pair's artwork reaches goes through the native
`@resvg/resvg-js` binding, so install the assistant package's dependencies
first: `bun install --filter=@vellumai/assistant`. `pr-native-drift.yaml` and
`ci-main-native-drift.yaml` run that same test and watch both
`app/src/main/res/**` and `app/src/main/AndroidManifest.xml`, so an edit without
a regeneration fails CI.

| Generated resource | Count | Contents |
|--------------------|-------|----------|
| `drawable/avatar_eyes_fg_<eye>.xml` | 9 | The eye pair on a transparent field, sized for the 72dp an adaptive-icon mask keeps visible |
| `drawable/avatar_eyes_mono_<eye>.xml` | 9 | The same pair reduced to its sclera silhouette, which a themed icon reads for alpha |
| `mipmap-anydpi-v26/avatar_eyes_<eye>_<color>.xml` | 54 | Adaptive icon pairing the foreground with a background color |
| `mipmap-anydpi-v33/avatar_eyes_<eye>_<color>.xml` | 54 | The same adaptive icon plus the monochrome layer |
| `mipmap-anydpi/avatar_eyes_<eye>_<color>.xml` | 54 | Pre-adaptive fallback that paints its own background and draws the pair 1.5x larger to fill all 108dp |
| `values/avatar_icon_colors.xml` | 6 colors | The alternate backgrounds, kept apart from the flavor-owned `launcher_background` because an alternate looks the same in every flavor |

The generator also owns the `avatar-icon-aliases` marker block in
`AndroidManifest.xml`. Android reads the launcher icon off whichever launcher
component is enabled, so every launcher entry is an `<activity-alias>` targeting
`.MainActivity`: `.icon.primary`, enabled and drawn with the `ic_launcher`
artwork, then one disabled `.icon.avatar_eyes_<eye>_<color>` alias per
alternate. Exactly one launcher-bearing alias is enabled at a time. Each alias
carries a MAIN/LAUNCHER filter and a copy of `.MainActivity`'s shortcuts
`<meta-data>`, and nothing else: a launcher reads static shortcuts off the
component it launched, while deep links resolve through `.MainActivity` alone,
so cloning its VIEW filters onto 55 components would only multiply the App Links
verification surface.

`.MainActivity` therefore declares no MAIN/LAUNCHER filter of its own. It holds
every deep-link filter and the shortcuts `<meta-data>` the aliases copy, carries
no `android:enabled` attribute, and is never toggled, so the static shortcuts,
the voice status notification, and the Quick Settings tile, which all name its
class explicitly, resolve whichever icon is picked.

`AppIconPlugin.java` does the switching, on the same Capacitor contract as iOS:
`getState` resolves `{supported, current, available}` and `set` resolves `{ok}`
plus an `error` when it refuses. Toggling a launcher component makes the
launcher re-resolve the app, which some launchers answer by dropping the running
task, so `set` only records the target in the `app_icon` SharedPreferences file
and `handleOnStop` applies it once the activity has left the screen. Until the
toggle lands, `getState` reports the recorded target as `current`, so the web
layer's re-read after an apply sees the icon it asked for. An apply enables the
target before disabling the others and clears the record last, so no launcher
sees the app with every launcher component off, and an interrupted pass is
retried rather than half kept. It reads its alias set off the manifest and takes
`.icon.primary` plus the `.icon.avatar_eyes_*` alternates only, so an activity
that lands in the `.icon.` namespace for anything else is neither offered in
`available` nor toggled by an apply.

`load()` runs that same apply before the activity resumes, so a process death
between `set` and the next background never strands a recorded target. It then
holds one more invariant: an enabled-state override outlives the install that
wrote it, so a device carrying an explicit disable on `.icon.primary` alongside
an applied alternate that the installed build does not declare has no launcher
entry at all. Whenever no declared alias is drawing the app, `.icon.primary`
goes back to `COMPONENT_ENABLED_STATE_DEFAULT`.

The web layer addresses an icon by its wire name, `avatar-eyes-<eye>-<color>`,
the same name iOS uses. Resource and class names admit underscores rather than
dashes, so an alias suffix is that whole string with every dash swapped for an
underscore, and the reverse is the same whole-string swap. It round-trips only
while no catalog id carries a separator of its own, which
`assertUnderscoreSafeIds` in `clients/ios/scripts/avatar-icon-core.ts` enforces
on every run.

`getState` reports `supported: true` only on API 26 or newer with at least one
alternate present. `minSdkVersion` is 24, so an API 24 or 25 device answers
`supported: false` and the picker draws nothing. `set` applies the same version
check and resolves `{ok: false, error}` below it, so a caller that skipped
`supported` cannot leave a target behind for the next background to toggle.

Alternates read at the size of the default launcher icon sitting next to them in
the picker. Each pair is fitted by the longer edge of its measured artwork
bounds to a fraction of the 72dp an adaptive mask keeps visible, and the
pre-adaptive fallback multiplies that scale by 108/72.

| Eye style | Span of the masked square |
|-----------|---------------------------|
| `dazed` | 0.55 |
| `bashful` | 0.40 |
| Every other style | 0.5 |

The 0.5 default is the framing the default launcher icon uses, so the generated
`quirky` foreground lands on that icon's own scale, within the rounding step
that separates a hand-rounded bounding box from a rasterized measurement.
`dazed` is framed wider so it reads at the size of the rest, and `bashful`
narrower so it does not draw the same icon as `surprised`, which is the same
shape. The spans live in `clients/ios/scripts/avatar-icon-core.ts`, shared with
the iOS generator and mirrored by
`clients/web/src/components/avatar/app-icon-preview.tsx` so the picker's
on-screen preview frames a pair the way the launcher does.

### Device QA Checklist

Launcher behavior is physical-device territory; an emulator does not cover it.

- Apply an alternate and reset to the default on both a Pixel launcher and a
  Samsung One UI launcher. The icon changes when the app goes to the background,
  not on the press.
- Pin the app icon to the home screen from a build that declares no aliases,
  install this build over it, and confirm any resulting pin loss happens at most
  once. Pin again, switch icons, and record what each launcher does to the pin.
- Long-press the launcher icon while an alternate is active and confirm the New
  chat and Start voice shortcuts are still listed. Check the voice status
  notification tap and the Start voice Quick Settings tile in the same state.
- Open an auth callback deep link and an HTTPS App Link while an alternate is
  active. Both resolve through `.MainActivity`, so neither should behave
  differently.
- Apply an icon and immediately hand off to a browser, so the handoff is what
  first backgrounds the app: a sign-in, which `NativeAuthPlugin` sends to the
  system browser, and a purchase CTA, which opens a Custom Tab through the
  Capacitor Browser plugin. Either one stops the activity, so the pending toggle
  applies mid-flow. On each launcher, confirm the sign-in's custom-scheme
  callback still completes and that coming back from the purchase page lands on
  a live task rather than one the launcher dropped.
- Turn on themed icons on Android 13 or newer and confirm every alternate draws
  its sclera silhouette rather than a blank tile or a filled square.
- Set an icon, force-stop the app before it reaches the background
  (`adb shell am force-stop ai.vellum.assistant.dev`), and relaunch. `load()`
  applies the recorded target.
- Install on an API 24 or 25 device and confirm the App icon row does not
  render.
- Build a release variant (`./gradlew :app:assembleProductionRelease`), which
  enables `minifyEnabled` and `shrinkResources`, and confirm every alias draws
  its own icon, so resource shrinking keeps mipmaps referenced only from the
  manifest.

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
