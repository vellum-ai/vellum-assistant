# Windows parity matrix

Parity is defined by the `VellumBridge` contract in
`packages/ipc-contract/src/bridge.ts`: the Windows preload must expose every
key the macOS preload exposes, except the surfaces listed under
[Not applicable](#not-applicable-on-windows). `src/preload/bridge-parity.test.ts`
enforces this by composing the real Windows feature modules and diffing their
nested surface against the macOS preload; the only permitted deltas are the
ones documented there and below.

Evidence columns name the focused test (under `src/`) or the packaged smoke
(`scripts/package-smoke.ts`, run by `.github/workflows/windows-package-smoke.yaml`)
that exercises the Windows behavior.

## Renderer bridge

| Bridge key                                                            | Windows module                                                                                        | macOS counterpart                        | Evidence                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| `platform`, `hostOS`, `app`, `commands`, `mainWindow`                 | `preload/core-capabilities.ts`                                                                        | `preload/index.ts`                       | `preload/bridge-parity.test.ts`, `main/main-window.test.ts`                     |
| `auth`                                                                | `preload/features/auth.ts`, `main/features/auth.ts`                                                   | `main/native-auth`                       | `main/auth-callback.test.ts`                                                    |
| `hotkeys`, `menu`                                                     | `preload/features/commands.ts`, `main/features/commands.ts`, `main/menu.ts`                           | `main/menu.ts`, `main/commands.ts`       | `main/menu.test.ts`                                                             |
| `launchAtLogin`, `deepLinks`                                          | `preload/features/deep-links.ts`, `main/features/deep-links.ts`                                       | `main/deep-links.ts`                     | `preload/deep-links-feature.test.ts`                                            |
| `featureFlags`, `diagnostics`, `feedback`                             | `preload/features/diagnostics.ts`, `main/features/diagnostics.ts`                                     | `main/diagnostics.ts`                    | `preload/presence-feature.test.ts`                                              |
| `helper` (ping, state, restart, dictation partials and transcription) | `preload/features/dictation.ts`, `main/features/dictation.ts`, `main/windows-helper.ts`               | `native/mac-helper`                      | `main/dictation.test.ts`, `native/Vellum.WindowsHelper.Tests`                   |
| `permissions`, `text`                                                 | `preload/features/permissions.ts`, `main/features/permissions.ts`                                     | `main/permissions.ts`                    | `main/permissions-feature.test.ts`                                              |
| `status`, `identity`, `icon`, `dock`, `power`, `connectivity`         | `preload/features/presence.ts`, `main/features/presence.ts`, `main/tray.ts`, `main/taskbar.ts`        | `main/dock.ts`, `main/tray.ts`           | `preload/presence-feature.test.ts`, `main/tray.test.ts`, `main/taskbar.test.ts` |
| `share`, `notifications`                                              | `preload/features/notifications-share.ts`, `main/features/share.ts`, `main/features/notifications.ts` | `main/share.ts`, `main/notifications.ts` | `main/notifications-share-feature.test.ts`                                      |
| `localMode`                                                           | `preload/features/local-mode.ts`, `main/features/local-mode.ts`, `main/local-mode-providers.ts`       | `main/local-mode.client.ts`              | `main/local-mode-feature.test.ts`, `main/cli-provisioning.test.ts`              |
| `fileOpen`, `paths`                                                   | `preload/features/paths.ts`, `main/features/file-open.ts`                                             | `main/file-open.ts`                      | `preload/paths.test.ts`, `main/file-open.test.ts`                               |
| `bundleConfirm`                                                       | `preload/features/bundles.ts`, `main/features/bundles.ts`                                             | `main/bundles.ts`                        | `main/bundles-feature.test.ts`, package smoke (`.vellum` association)           |
| `quickInput`, `commandPalette`, `dictationOverlay`, `popout`          | `preload/features/auxiliary-windows.ts`, `main/features/auxiliary-windows.ts`                         | `main/*-window.ts`                       | `main/auxiliary-windows.test.ts`                                                |
| `update`                                                              | `preload/features/auto-update.ts`, `main/features/auto-update.ts`, `main/auto-update.ts`              | `main/auto-update.ts`                    | `main/auto-update.test.ts`                                                      |

## Main-process capabilities without a bridge key

| Capability                                                          | Windows module                                                                                       | Evidence                                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Host proxy (gateway forwarding, host executors, computer use)       | `main/features/host-proxy.ts`, `main/host-proxy-adapter.ts`, `main/features/computer-use-actions.ts` | `main/host-proxy-feature.test.ts`, `main/host-proxy-adapter.test.ts`, `main/computer-use-actions-feature.test.ts` |
| Packaged CLI provisioning and launcher                              | `main/cli-installer.ts`, `main/cli-path-flow.ts`                                                     | `main/cli-provisioning.test.ts`, `scripts/launch-cli.test.ts`, package smoke                                      |
| `app://` gateway and paired-gateway forwarding, platform forwarding | `main/index.ts`, `main/paired-gateway-request-guard.ts`                                              | `main/paired-gateway-request-guard.test.ts`, `@vellumai/electron-desktop` `gateway-forward.test.ts`               |
| Explorer preview and thumbnail handler                              | `native/Vellum.PreviewHandler`                                                                       | `native/Vellum.PreviewHandler.Tests`, package smoke                                                               |
| NSIS install, protocol and file registration, uninstall             | `electron-builder.config.cjs`, `scripts/installer.nsh`                                               | package smoke                                                                                                     |

## Windows-only surface

| Surface                         | Why                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `menu.titles`, `menu.popup`     | The shell hides the native frame, so the renderer draws the menu bar in its title bar. |
| `mainWindow.setTitleBarOverlay` | Native caption buttons are themed with the renderer's palette.                         |

## Not applicable on Windows

| macOS concept                                           | Windows equivalent                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `companion`, `voiceActivity` (companion surface)        | None. The shell opens no floating companion window; the renderer feature-detects both keys. |
| `helper.hotkey` (Fn push-to-talk)                       | A configurable global chord registered through `hotkeys`.                                   |
| Dock badge and bounce                                   | Taskbar overlay icon and attention flash (`main/taskbar.ts`).                               |
| Share sheet                                             | Native Save As dialog (`main/features/share.ts`).                                           |
| Quick Look extension                                    | Explorer preview and thumbnail handler.                                                     |
| Accessibility, Input Monitoring, Automation permissions | No Windows permission concept; the rows are hidden on a Windows host.                       |
| Notarization and stapling                               | Authenticode signatures, verified at release time.                                          |
