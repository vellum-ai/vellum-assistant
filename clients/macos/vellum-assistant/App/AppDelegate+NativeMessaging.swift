import AppKit
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+NativeMessaging")

/// Install-time hook for the Chrome native messaging host manifest.
///
/// See `NativeMessagingInstaller` and
/// `clients/chrome-extension/native-host/` for the full flow:
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
            // been built yet (see `clients/chrome-extension/native-host`
            // and the build.sh wiring). Not an error — the self-hosted
            // Chrome extension pairing flow (PR 13) is optional, and
            // everything else in the assistant continues to work.
            log.info("vellum-chrome-native-host helper not bundled — skipping Chrome manifest install (dev build?)")
            return
        }

        do {
            try NativeMessagingInstaller.installChromeManifest(
                helperBinaryPath: helperBinaryUrl,
                extensionIds: ChromeExtensionAllowlist.allIds
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

/// Chrome extension IDs used when writing the native messaging manifest's
/// `allowed_origins` entries. Resolved from merged allowlist sources:
/// canonical config, local override, and environment overrides.
///
/// Kept in a standalone enum so unit tests can reference it without
/// instantiating `AppDelegate`.
enum ChromeExtensionAllowlist {
    private static let fallbackPlaceholderId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private static let extensionIdRegex = try! NSRegularExpression(pattern: "^[a-p]{32}$")
    private static let localOverrideFilename = "chrome-extension-allowlist.local.json"

    /// All valid extension IDs merged from:
    /// 1. Canonical repo allowlist config.
    /// 2. Per-machine local override under `~/.vellum/`.
    /// 3. Environment overrides (`VELLUM_CHROME_EXTENSION_IDS` /
    ///    `VELLUM_CHROME_EXTENSION_ID`).
    ///
    /// Used to populate the native messaging manifest's `allowed_origins`
    /// array so both the published extension and local unpacked builds can
    /// connect when explicitly allowlisted.
    static var allIds: [String] {
        let ids = mergedIds(
            canonicalCandidates: canonicalConfigPathCandidates(),
            localOverridePath: localOverridePath(),
            environment: ProcessInfo.processInfo.environment
        )
        if !ids.isEmpty {
            return ids
        }
        return [fallbackPlaceholderId]
    }

    /// The first valid extension ID — used when a single ID is needed.
    static var primaryId: String {
        allIds.first ?? fallbackPlaceholderId
    }

    /// Testable helper: merge IDs from canonical/local/env sources.
    ///
    /// Canonical config uses first-valid-candidate-wins semantics so source
    /// and cwd path candidates are treated as one logical source.
    static func mergedIds(
        canonicalCandidates: [URL],
        localOverridePath: URL,
        environment: [String: String]
    ) -> [String] {
        var merged: [String] = []
        var seen = Set<String>()

        for candidate in canonicalCandidates {
            guard let canonicalIds = readIdsFromAllowlistFile(candidate) else {
                continue
            }
            appendUnique(canonicalIds, into: &merged, seen: &seen)
            break
        }

        if let localIds = readIdsFromAllowlistFile(localOverridePath, allowEmpty: true) {
            appendUnique(localIds, into: &merged, seen: &seen)
        }

        appendUnique(
            parseIdsFromEnvironmentList(environment["VELLUM_CHROME_EXTENSION_IDS"]),
            into: &merged,
            seen: &seen
        )
        if let singleEnvId = parseSingleIdFromEnvironment(environment["VELLUM_CHROME_EXTENSION_ID"]) {
            appendUnique([singleEnvId], into: &merged, seen: &seen)
        }

        return merged
    }

    private static func appendUnique(
        _ ids: [String],
        into merged: inout [String],
        seen: inout Set<String>
    ) {
        for id in ids where !seen.contains(id) {
            seen.insert(id)
            merged.append(id)
        }
    }

    private static func parseIdsFromEnvironmentList(_ raw: String?) -> [String] {
        guard let raw else { return [] }
        let tokens = raw
            .components(separatedBy: CharacterSet(charactersIn: ",").union(.whitespacesAndNewlines))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return tokens.filter { isValidExtensionId($0) }
    }

    private static func parseSingleIdFromEnvironment(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return isValidExtensionId(trimmed) ? trimmed : nil
    }

    private static func readIdsFromAllowlistFile(
        _ path: URL,
        allowEmpty: Bool = false
    ) -> [String]? {
        guard let data = try? Data(contentsOf: path),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ids = raw["allowedExtensionIds"] as? [String]
        else {
            return nil
        }

        let valid = ids.filter { isValidExtensionId($0) }
        if valid.isEmpty && !allowEmpty {
            return nil
        }
        return valid
    }

    private static func isValidExtensionId(_ value: String) -> Bool {
        let fullRange = NSRange(value.startIndex..<value.endIndex, in: value)
        let match = extensionIdRegex.firstMatch(in: value, options: [], range: fullRange)
        return match != nil
    }

    private static func localOverridePath() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum", isDirectory: true)
            .appendingPathComponent(localOverrideFilename, isDirectory: false)
    }

    private static func canonicalConfigPathCandidates() -> [URL] {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let fromCwd = cwd
            .appendingPathComponent("meta", isDirectory: true)
            .appendingPathComponent("browser-extension", isDirectory: true)
            .appendingPathComponent("chrome-extension-allowlist.json", isDirectory: false)

        let sourceFile = URL(fileURLWithPath: #filePath, isDirectory: false)
        // #filePath points at:
        // .../clients/macos/vellum-assistant/App/AppDelegate+NativeMessaging.swift
        // so climbing 5 levels lands at repo root.
        let fromSource = sourceFile
            .deletingLastPathComponent() // App
            .deletingLastPathComponent() // vellum-assistant
            .deletingLastPathComponent() // macos
            .deletingLastPathComponent() // clients
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("meta", isDirectory: true)
            .appendingPathComponent("browser-extension", isDirectory: true)
            .appendingPathComponent("chrome-extension-allowlist.json", isDirectory: false)

        return [fromCwd, fromSource]
    }
}
