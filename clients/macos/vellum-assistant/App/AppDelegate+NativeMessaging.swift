import AppKit
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+NativeMessaging")

/// Install-time hook for the Chrome native messaging host manifest.
///
/// See `NativeMessagingInstaller` and
/// `clients/chrome-extension-native-host/` for the full flow:
/// this extension is responsible for (1) locating the bundled
/// `vellum-chrome-native-host` helper binary inside the `.app`
/// bundle at launch time, and (2) writing the
/// `com.vellum.daemon.json` manifest into Chrome's well-known
/// `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
/// directory so Chrome will spawn that helper when the Vellum
/// extension calls `chrome.runtime.connectNative("com.vellum.daemon")`.
///
/// This runs off the main thread from `applicationDidFinishLaunching`
/// because writing to `~/Library` involves disk I/O and we do not
/// want to block app launch if the directory has unusual permissions.
/// It also runs unconditionally on every launch (cheap, idempotent)
/// so that upgrading the app bundle automatically repoints the
/// manifest at the newer helper binary path.
extension AppDelegate {

    /// Installs the Chrome native messaging host manifest for the
    /// Vellum chrome extension. Idempotent — safe to call on every
    /// launch. Runs off the main thread.
    ///
    /// This method is deliberately non-`@MainActor`: it touches no
    /// app state, does pure file I/O under `~/Library`, and follows
    /// the same off-main-thread pattern as `installCLISymlinkIfNeeded`.
    nonisolated static func installChromeNativeMessagingHostIfNeeded() {
        guard let helperBinaryUrl = resolveBundledNativeMessagingHelper() else {
            // Normal for dev builds where the helper binary hasn't
            // been built yet (see `clients/chrome-extension-native-host`
            // and the build.sh wiring). Not an error — the self-hosted
            // Chrome extension pairing flow (PR 13) is optional, and
            // everything else in the assistant continues to work.
            log.info("vellum-chrome-native-host helper not bundled — skipping Chrome manifest install (dev build?)")
            return
        }

        do {
            try NativeMessagingInstaller.installChromeManifest(
                helperBinaryPath: helperBinaryUrl,
                extensionId: ChromeExtensionAllowlist.devPlaceholderId
            )
        } catch {
            // Best-effort: a failing manifest install must not crash
            // the app. Log at warning so it shows up in diagnostics
            // but does not spam the error channel.
            log.warning(
                "Failed to install Chrome native messaging manifest: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    /// Resolves the absolute URL of the bundled
    /// `vellum-chrome-native-host` helper binary inside the running
    /// app bundle, or `nil` if it is not present (dev builds that
    /// haven't run the helper's `bun run build` yet).
    ///
    /// Tries `Bundle.main.url(forAuxiliaryExecutable:)` first — which
    /// is the Apple-recommended way to look up secondary binaries
    /// inside `Contents/MacOS/` — and falls back to a direct path
    /// computation for builds that package the binary at a
    /// non-standard location.
    nonisolated static func resolveBundledNativeMessagingHelper() -> URL? {
        let binaryName = "vellum-chrome-native-host"

        if let url = Bundle.main.url(forAuxiliaryExecutable: binaryName) {
            return url
        }

        // Fallback: compute the path directly against the bundle's
        // executable URL. This matches how `installCLISymlinkIfNeeded`
        // discovers the `vellum-cli` sibling binary.
        if let execURL = Bundle.main.executableURL {
            let candidate = execURL
                .deletingLastPathComponent()
                .appendingPathComponent(binaryName)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }
}

/// Hard-coded allowlist of Chrome extension IDs the installer pins
/// into the manifest's `allowed_origins`. Must stay in lockstep with
/// `ALLOWED_EXTENSION_IDS` in
/// `clients/chrome-extension-native-host/src/index.ts` (PR 7) and the
/// allowlist the assistant's `/v1/browser-extension-pair` endpoint
/// checks (PR 11).
///
/// Kept in a standalone enum so unit tests can reference it without
/// instantiating `AppDelegate`.
enum ChromeExtensionAllowlist {
    /// Dev placeholder id. Matches the single entry currently present
    /// in the helper binary's allowlist in PR 7. Replaced before
    /// release with the production extension id — see the
    /// `TODO: production id before release` comment in
    /// `clients/chrome-extension-native-host/src/index.ts`.
    static let devPlaceholderId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
