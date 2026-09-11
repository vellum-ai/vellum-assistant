# Desktop apps

Open the Desktop modal and choose **Add apps**. Calculator and Text Editor are optional lightweight Linux apps. **Install** adds the selected app and launcher in the background. **Add to desktop** creates a launcher for an app whose binary already exists. **Open** requires a connected desktop and opens a window there. Right-click its Plank icon and choose **Keep in Dock** to pin it. Users can remove pins without the application manager putting them back.

The catalog uses fixed app IDs. Package names, executable paths, X resources and arguments are server-owned. The guardian-authorized gateway accepts the same flat and assistant-scoped route shapes as desktop setup. Neither installation nor launch targets the user's host. The default-off `assistant-desktop` flag and container gate apply to every request.

## Installation and licensing

The image uses Debian trixie. Both supported architectures use the distribution's signed APT metadata and package hashes. The app installer shares the desktop setup queue, CA handling, bounded command execution, and sanitized subprocess environment. It downloads `x11-apps`, extracts in temporary storage, then retains only the selected binary, its app-defaults, xedit's Lisp resources when applicable, and the package copyright file. It does not register the bundle with dpkg or run maintainer scripts. Other bundled apps, including GPL-licensed rendercheck, are discarded. No new base-image dependencies are added.

The selected xcalc code uses X Consortium/MIT terms; xedit uses BSD and permissive X11 terms. The Debian copyright notice is retained at `/usr/share/doc/vellum-desktop-apps/copyright`. Its upstream source is [Debian's x11-apps copyright](https://metadata.ftp-master.debian.org/changelogs/main/x/x11-apps/unstable_copyright). PNG icons are first-party assets, and launchers name each real `WM_CLASS` for BAMF/Plank grouping.

## Persistence

- Restarting or idling the X11 desktop keeps installed image-root binaries and workspace-backed launchers.
- Recreating the assistant container or restoring a Kata snapshot can discard the image root. Desktop setup and the selected apps then require explicit installation again.
- Launchers, icons and user pins live in the existing `data/desktop-panel` directory. No new manifest or storage format is introduced.
- Readiness is derived from the actual binary and launcher. A stale pin does not claim an app is installed. The catalog offers Install again after root replacement.
- Installation continues if the modal closes. An assistant process interruption loses in-memory progress; the next request discovers the filesystem state and permits retry. Publish-last binaries prevent partial extraction from looking complete.
- User files survive only when saved to persistent workspace storage. Open windows and unsaved documents do not survive desktop teardown.

The initial catalog has no arbitrary packages, URLs, uninstall, upgrades, automatic reinstallation, or discovery of every system app. Open creates a new window; the dock provides grouping, focus, and window selection. At most 16 API-launched app windows may remain open concurrently.

## Validation

Focused tests cover concurrent installation, retry, installed-app launcher creation, customization preservation, root-replacement detection, live-viewer launch requirements, sanitized display environment, process teardown, gateway guardian authorization, and structured-input rejection. UI tests cover installation progress, Open, retry and older-assistant fallback.

Linux smoke validation should use a disposable trixie container: initialize the same desktop dependencies, run the actual selective installer, verify the two `WM_CLASS` values (`XCalc` and `Xedit`), check BAMF desktop-file association and PNG icons, then pin, restart, and reopen. Removing app binaries must offer Install without removing existing pins. Never use host package installation for this check.
