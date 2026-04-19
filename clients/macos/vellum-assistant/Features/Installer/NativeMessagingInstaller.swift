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
/// See `clients/chrome-extension/native-host/` (PR 7) for the helper
/// binary and `clients/chrome-extension/native-host/com.vellum.daemon.json.template`
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
    ///
    /// Conforms to `LocalizedError` (rather than only
    /// `CustomStringConvertible`) so that `error.localizedDescription`
    /// returns the human-readable string below instead of Foundation's
    /// generic "The operation couldn't be completed (… error 0.)"
    /// fallback. This matches the convention used by other error types
    /// in this app (see `RecorderError`, `CaptureError`,
    /// `ExecutorError`, etc.).
    public enum InstallError: Error, LocalizedError {
        case helperBinaryMissing(URL)

        public var errorDescription: String? {
            switch self {
            case .helperBinaryMissing(let url):
                return "Native messaging helper binary not found at \(url.path)"
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
    ///   - extensionIds: Chrome extension IDs to pin in
    ///     `allowed_origins`. Should include both the development and
    ///     CWS production IDs so the native host accepts connections
    ///     from either origin.
    public static func installChromeManifest(
        helperBinaryPath: URL,
        extensionIds: [String]
    ) throws {
        try installChromeManifest(
            helperBinaryPath: helperBinaryPath,
            extensionIds: extensionIds,
            vellumEnvironment: ProcessInfo.processInfo.environment["VELLUM_ENVIRONMENT"],
            processEnvironment: ProcessInfo.processInfo.environment,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            fileManager: FileManager.default,
            gatekeeperAssessment: Self.runGatekeeperAssessment(at:)
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
        extensionIds: [String],
        vellumEnvironment: String? = nil,
        processEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL,
        fileManager: FileManager,
        gatekeeperAssessment: (String) -> Bool = { _ in true }
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
        let launcherUrl = launcherScriptPath(under: homeDirectory)
        let helperPathForLauncher = resolveHelperPathForLauncher(
            bundledHelperPath: helperBinaryPath.path,
            manifestUrl: manifestUrl,
            launcherUrl: launcherUrl,
            fileManager: fileManager,
            gatekeeperAssessment: gatekeeperAssessment
        )
        guard let helperPathForLauncher else {
            // Chrome refuses to launch a native messaging host that
            // Gatekeeper rejects, so installing a manifest that points at a
            // rejected helper leaves the extension permanently unable to
            // connect — and worse, clobbers any working manually-installed
            // manifest on every app launch. Skip the install in that case
            // and let the developer fall back to the manual setup documented
            // in clients/chrome-extension/README.md.
            log.warning(
                "Skipping Chrome native messaging manifest install: bundled helper at \(helperBinaryPath.path, privacy: .public) is not accepted by Gatekeeper (expected for local dev builds with a self-signed helper), and no existing trusted helper path could be reused. Follow the manual setup in clients/chrome-extension/README.md to install the extension bridge."
            )
            return
        }

        let resolvedEnvironment = resolvedLauncherEnvironment(
            vellumEnvironment: vellumEnvironment,
            processEnvironment: processEnvironment
        )
        let launcherContents = buildLauncherScriptContents(
            helperBinaryPath: helperPathForLauncher,
            vellumEnvironment: resolvedEnvironment
        )
        try launcherContents.write(to: launcherUrl, atomically: true, encoding: .utf8)
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o755)],
            ofItemAtPath: launcherUrl.path
        )

        // JSONSerialization is used (rather than a Codable struct) so the
        // field order matches the Chrome-expected shape and so the
        // structure lines up 1:1 with the .template file checked into
        // the chrome-extension/native-host package.
        //
        // Swift dictionaries are unordered, but Chrome doesn't care about
        // field order — it just parses the object — so we prioritize
        // clarity here.
        let manifest: [String: Any] = [
            "name": hostName,
            "description": hostDescription,
            "path": launcherUrl.path,
            "type": "stdio",
            "allowed_origins": extensionIds.map { "chrome-extension://\($0)/" },
            // Metadata for Vellum's installer fallback logic. Chrome ignores
            // unknown keys in native host manifests.
            "vellum_helper_path": helperPathForLauncher,
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
        let launcherUrl = launcherScriptPath(under: homeDirectory)
        if fileManager.fileExists(atPath: manifestUrl.path) {
            try fileManager.removeItem(at: manifestUrl)
            log.info("Removed Chrome native messaging manifest at \(manifestUrl.path, privacy: .public)")
        }
        if fileManager.fileExists(atPath: launcherUrl.path) {
            try fileManager.removeItem(at: launcherUrl)
            log.info("Removed Chrome native messaging launcher at \(launcherUrl.path, privacy: .public)")
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

    /// Path to the launcher script referenced by the native messaging manifest.
    ///
    /// The script exports `VELLUM_ENVIRONMENT` before exec'ing the real helper
    /// binary so Chrome-launched processes resolve the correct env-scoped
    /// lockfile paths even when Chrome provides a minimal process environment.
    internal static func launcherScriptPath(under homeDirectory: URL) -> URL {
        manifestDirectory(under: homeDirectory)
            .appendingPathComponent("\(hostName)-launcher.sh")
    }

    internal static func resolvedLauncherEnvironment(
        vellumEnvironment: String?,
        processEnvironment: [String: String]
    ) -> String {
        if let resolved = normalizeEnvironmentName(vellumEnvironment) {
            return resolved
        }
        if shouldDefaultToLocalEnvironment(processEnvironment: processEnvironment) {
            return "local"
        }
        // Local source builds default to dev so developers hit the dev cloud
        // stack unless they explicitly opt into local full-stack behavior.
        return "dev"
    }

    internal static func buildLauncherScriptContents(
        helperBinaryPath: String,
        vellumEnvironment: String
    ) -> String {
        let escapedBinaryPath = shellSingleQuote(helperBinaryPath)
        let escapedEnv = shellSingleQuote(vellumEnvironment)

        return """
#!/bin/sh
set -e
if [ -z "${VELLUM_ENVIRONMENT:-}" ]; then export VELLUM_ENVIRONMENT=\(escapedEnv); fi
exec \(escapedBinaryPath) "$@"
"""
    }

    private static func normalizeEnvironmentName(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        switch trimmed {
        case "local", "dev", "test", "staging", "production":
            return trimmed
        default:
            return nil
        }
    }

    private static func shouldDefaultToLocalEnvironment(
        processEnvironment: [String: String]
    ) -> Bool {
        isLoopbackHttpURL(processEnvironment["VELLUM_PLATFORM_URL"]) ||
        isLoopbackHttpURL(processEnvironment["VELLUM_WEB_URL"])
    }

    private static func isLoopbackHttpURL(_ raw: String?) -> Bool {
        guard let raw,
              let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              scheme == "http",
              let host = url.host?.lowercased() else {
            return false
        }
        return host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".localhost")
    }

    private static func resolveHelperPathForLauncher(
        bundledHelperPath: String,
        manifestUrl: URL,
        launcherUrl: URL,
        fileManager: FileManager,
        gatekeeperAssessment: (String) -> Bool
    ) -> String? {
        if gatekeeperAssessment(bundledHelperPath) {
            return bundledHelperPath
        }

        // Local dev helper binaries are often unsigned/self-signed and fail
        // Gatekeeper checks. In that case, fall back to an already-installed
        // trusted helper path when available so we can still update launcher
        // env wiring (for example, flipping from production -> local lockfile
        // scope) without breaking native-host launchability.
        if let fallbackPath = readExistingHelperPath(
            manifestUrl: manifestUrl,
            launcherUrl: launcherUrl,
            fileManager: fileManager
        ) {
            log.warning(
                "Bundled native helper at \(bundledHelperPath, privacy: .public) is not accepted by Gatekeeper; reusing existing helper path \(fallbackPath, privacy: .public)"
            )
            return fallbackPath
        }
        return nil
    }

    private static func readExistingHelperPath(
        manifestUrl: URL,
        launcherUrl: URL,
        fileManager: FileManager
    ) -> String? {
        guard let data = try? Data(contentsOf: manifestUrl),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        if let explicitHelperPath = parsed["vellum_helper_path"] as? String {
            let trimmed = explicitHelperPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && fileManager.fileExists(atPath: trimmed) {
                return trimmed
            }
        }

        if let manifestPath = parsed["path"] as? String {
            let trimmed = manifestPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty,
               trimmed != launcherUrl.path,
               fileManager.fileExists(atPath: trimmed) {
                return trimmed
            }
        }

        return nil
    }

    private static func shellSingleQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }

    /// Runs `spctl -a -vv <path>` and returns `true` when Gatekeeper
    /// accepts the binary. Local dev builds ship a self-signed helper
    /// that fails this check; notarized release builds pass.
    private static func runGatekeeperAssessment(at path: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/spctl")
        process.arguments = ["-a", "-vv", path]
        let sink = Pipe()
        process.standardOutput = sink
        process.standardError = sink
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }
}
