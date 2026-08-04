# Android and iOS Parity QA

This checklist validates Android release readiness without treating a simulator,
debug install, or source review as physical-device evidence. Every result starts
as **Not run**. Update a row only after testing the named build on the named
device.

## Launch gates

Do not start production sign-off until all applicable gates are complete:

- [ ] The production Play listing for `ai.vellum.assistant` is reachable.
- [ ] Play App Signing and upload credentials are configured.
- [ ] A production AAB has reached the Play internal track.
- [ ] Firebase configuration is present for the tested flavor.
- [ ] APNs and FCM dispatch is deployed for the tested backend environment.
- [ ] Digital Asset Links is public for the tested origin and signing identity.
- [ ] `VITE_ANDROID_PLAY_STORE_URL` points to the live production listing.
- [ ] Play listing, privacy policy, Data Safety, content rating, and permission
  declarations have received the required human approvals.

## Recording results

Run each row against both device classes for every environment before marking
that environment complete:

- Current: a currently supported Pixel-class device on the latest stable
  Android release.
- Older: a physical device on the oldest Android release the app supports.

Replace `Not run`, `Unassigned`, and `-` with the actual result, owner, and
evidence or defect link. Split a row when device or OS results differ. Allowed
results are `Pass`, `Fail`, `Blocked`, and `Not run`.

## Parity matrix

| Area | Environments | Required device and OS | Check | Result | Owner | Evidence or defect |
| --- | --- | --- | --- | --- | --- | --- |
| Install | dev, staging, production | Current and older physical devices | Install the intended flavor from its Play internal track and confirm the package, name, icon, and web origin. | Not run | Unassigned | - |
| Upgrade | dev, staging, production | Current and older physical devices | Upgrade over the previous internal-track build without clearing app data; confirm session and server selection survive. | Not run | Unassigned | - |
| Cold launch | dev, staging, production | Current and older physical devices | Launch from the icon after force-stop and confirm fresh-chat routing without an unintended deep-link destination. | Not run | Unassigned | - |
| Back navigation | dev, staging, production | Current and older physical devices | Dismiss an overlay, navigate history, then minimize from the root using system Back and predictive Back where supported. | Not run | Unassigned | - |
| Cloud authentication | dev, staging, production | Current and older physical devices | Sign in through the system browser, return to the correct flavor, relaunch, and sign out. | Not run | Unassigned | - |
| OAuth and billing returns | dev, staging, production | Current and older physical devices | Complete and cancel each external flow; confirm the callback returns once to the correct in-app destination. | Not run | Unassigned | - |
| Self-hosted pairing | dev, staging, production | Current and older physical devices | Scan a pairing link into stopped and running apps; preserve the server path and do not persist the one-time code. | Not run | Unassigned | - |
| Server recovery | dev, staging, production | Current and older physical devices | Make the selected server unreachable, retry, then return to Vellum Cloud without clearing app data. | Not run | Unassigned | - |
| Biometric recovery | dev, staging, production | Current and older physical devices with enrolled biometrics | Enable, relaunch, recover, cancel, sign out, and exercise an invalidated enrollment. | Not run | Unassigned | - |
| HTTPS App Links | dev, staging, production | Current and older physical devices | Open owned chat, connect, voice, OAuth, and billing URLs after verification; confirm unowned paths stay in the browser. | Not run | Unassigned | - |
| Notifications | dev, staging, production | Current and older physical devices | Verify one foreground, background, and terminated notification; tap each into the intended conversation and test permission recovery. | Not run | Unassigned | - |
| Offline notifications | dev, staging, production | Current and older physical devices | Deliver after reconnect and Doze, rotate the FCM token, and confirm logout removes the active registration. | Not run | Unassigned | - |
| Voice foreground session | dev, staging, production | Current and older physical devices | Start, interrupt, change audio routes, end, and relaunch from notification, shortcut, and Quick Settings surfaces. | Not run | Unassigned | - |
| Files and sharing | dev, staging, production | Current and older physical devices | Attach, preview, download, open, and share supported files using Android system surfaces. | Not run | Unassigned | - |
| Haptics | dev, staging, production | Current and older physical devices | Exercise the same supported interaction feedback as iOS and confirm disabled system haptics do not break the flow. | Not run | Unassigned | - |
| Network recovery | dev, staging, production | Current and older physical devices | Move between Wi-Fi, cellular, offline, background, and foreground; confirm chat reconnects without duplicate turns. | Not run | Unassigned | - |
| Keyboard and insets | dev, staging, production | Current and older physical devices | Test composer focus, multiline input, attachments, rotation, gesture navigation, and three-button navigation without obscured controls. | Not run | Unassigned | - |
| Play promotion | production | Android browser on current and older physical devices | With the listing variable configured, open the web app, trigger the banner and settings card, and install from the production listing. | Not run | Unassigned | - |
| iOS regression | production | Supported physical iPhone | Confirm the existing App Store banner, settings card, dismissal state, install action, notifications, and biometric recovery still work. | Not run | Unassigned | - |
| Non-mobile regression | dev and production | Desktop browser, macOS app, and Windows app | Confirm Android promotion stays hidden and existing macOS, GitHub, and Discord nudge ordering is unchanged. | Not run | Unassigned | - |

## Intentional platform differences

- Android uses system Back and predictive Back. iOS uses its navigation gesture.
- Android uses FCM and notification channels. iOS uses APNs and badge state.
- Android voice status uses an ongoing notification, launcher shortcuts, and an
  optional Quick Settings tile. iOS uses Live Activities and App Intents.
- Android biometric labels depend on the enrolled authenticator. iOS uses Face
  ID or Touch ID labels.
- Reliable background microphone capture is not part of parity. Voice capture
  remains in the foreground WebView, so app switching and screen locking must
  not be reported as supported background voice behavior.

Parity sign-off requires every launch-blocking row to pass on both physical
device classes. A documented platform difference is acceptable only when it
does not claim an unsupported capability and has an assigned product owner.
