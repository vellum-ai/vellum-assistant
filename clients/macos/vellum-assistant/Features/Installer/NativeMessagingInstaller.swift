import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "NativeMessagingInstaller")

/// Installs and removes the Chrome Native Messaging host manifest that
/// points at the bundled `vellum-chrome-native-host` helper binary.
///
/// Chrome looks for per-user native messaging host manifests in
/// `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
/// When the Vellum Chrome extension calls
/// `chrome.runtime.connectNative("com.vellum.daemon")`, Chrome reads
/// `com.vellum.daemon.json` from that directory, verifies that the
/// calling extension's ID is on the manifest's `allowed_origins`
/// list, and spawns the binary referenced by `path`.
///
/// See `clients/chrome-extension-native-host/` (PR 7) for the helper
/// binary and `clients/chrome-extension-native-host/com.vellum.daemon.json.template`
/// for the shape of the manifest this installer writes.
///
/// This helper intentionally carries **no** app state so it can run
/// safely off the main thread from `applicationDidFinishLaunching`
/// without `@MainActor` isolation, matching the pattern used by
/// `AppDelegate.installCLISymlinkIfNeeded(isDevMode:)`.
public enum NativeMessagingInstaller {

    /// Canonical Chrome native messaging host name for the Vellum helper.
    /// Intentionally left as `com.vellum.daemon` because it is a technical
    /// identifier baked into Chrome's manifest lookup — not user-facing —
    /// and must match `chrome.runtime.connectNative("com.vellum.daemon")`
    /// in the extension (see PR 13).
    public static let hostName = "com.vellum.daemon"

    /// Human-readable description written into the manifest's
    /// `description` field. Per `clients/AGENTS.md` the user-facing
    /// wording prefers "assistant" over "daemon".
    public static let hostDescription = "Vellum assistant native messaging host"

    /// Errors surfaced by the installer. Rendered to the app log rather
    /// than bubbled to the UI — the assistant continues to run even if
    /// the manifest install fails, and the Chrome extension's
    /// self-hosted pairing flow (PR 13) will simply not work until it
    /// is resolved.
    public enum InstallError: Error, CustomStringConvertible {
        case helperBinaryMissing(URL)

        public var description: String {
            switch self {
            case .helperBinaryMissing(let url):
                return "helper binary not found at \(url.path)"
            }
        }
    }

    // MARK: - Public API

    /// Writes the `com.vellum.daemon.json` manifest under the current
    /// user's Chrome native messaging hosts directory. Overwrites any
    /// existing manifest so upgrades cleanly repoint at the new helper
    /// binary path.
    ///
    /// - Parameters:
    ///   - helperBinaryPath: Absolute path to the bundled native
    ///     messaging helper binary (e.g.
    ///     `…/Contents/MacOS/vellum-chrome-native-host`). Must exist —
    ///     Chrome refuses to spawn a host whose `path` is missing.
    ///   - extensionId: The Chrome extension ID to pin in
    ///     `allowed_origins`. Must match the allowlist enforced by the
    ///     helper binary itself (PR 7 `ALLOWED_EXTENSION_IDS`) and the
    ///     runtime pair endpoint's allowlist (PR 11).
    public static func installChromeManifest(
        helperBinaryPath: URL,
        extensionId: String
    ) throws {
        try installChromeManifest(
            helperBinaryPath: helperBinaryPath,
            extensionId: extensionId,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            fileManager: FileManager.default
        )
    }

    /// Removes the `com.vellum.daemon.json` manifest if present. Safe to
    /// call when the manifest does not exist — returns without error.
    public static func uninstallChromeManifest() throws {
        try uninstallChromeManifest(
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            fileManager: FileManager.default
        )
    }

    // MARK: - Testable overloads

    /// Test-only overload that allows injecting a mock home directory so
    /// the installer can be exercised without touching the real Chrome
    /// directory under the tester's home folder.
    internal static func installChromeManifest(
        helperBinaryPath: URL,
        extensionId: String,
        homeDirectory: URL,
        fileManager: FileManager
    ) throws {
        guard fileManager.fileExists(atPath: helperBinaryPath.path) else {
            throw InstallError.helperBinaryMissing(helperBinaryPath)
        }

        let targetDir = manifestDirectory(under: homeDirectory)
        try fileManager.createDirectory(
            at: targetDir,
            withIntermediateDirectories: true,
            attributes: nil
        )

        let manifestUrl = targetDir.appendingPathComponent("\(hostName).json")

        // JSONSerialization is used (rather than a Codable struct) so the
        // field order matches the Chrome-expected shape and so the
        // structure lines up 1:1 with the .template file checked into
        // the chrome-extension-native-host package.
        //
        // Swift dictionaries are unordered, but Chrome doesn't care about
        // field order — it just parses the object — so we prioritize
        // clarity here.
        let manifest: [String: Any] = [
            "name": hostName,
            "description": hostDescription,
            "path": helperBinaryPath.path,
            "type": "stdio",
            "allowed_origins": ["chrome-extension://\(extensionId)/"],
        ]

        let data = try JSONSerialization.data(
            withJSONObject: manifest,
            options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: manifestUrl, options: .atomic)

        // Chrome requires the manifest to be readable by the user; 0o644
        // is what Google's own documentation for macOS native messaging
        // host manifests uses and it matches the DMG/installer patterns
        // used elsewhere in this app.
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o644)],
            ofItemAtPath: manifestUrl.path
        )

        log.info("Installed Chrome native messaging manifest at \(manifestUrl.path, privacy: .public)")
    }

    internal static func uninstallChromeManifest(
        homeDirectory: URL,
        fileManager: FileManager
    ) throws {
        let manifestUrl = manifestDirectory(under: homeDirectory)
            .appendingPathComponent("\(hostName).json")
        if fileManager.fileExists(atPath: manifestUrl.path) {
            try fileManager.removeItem(at: manifestUrl)
            log.info("Removed Chrome native messaging manifest at \(manifestUrl.path, privacy: .public)")
        }
    }

    /// Resolves the directory where Chrome looks up per-user native
    /// messaging host manifests, given a home directory. Exposed so
    /// tests can build the expected path without duplicating the
    /// constant string.
    internal static func manifestDirectory(under homeDirectory: URL) -> URL {
        homeDirectory
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("Google", isDirectory: true)
            .appendingPathComponent("Chrome", isDirectory: true)
            .appendingPathComponent("NativeMessagingHosts", isDirectory: true)
    }
}
