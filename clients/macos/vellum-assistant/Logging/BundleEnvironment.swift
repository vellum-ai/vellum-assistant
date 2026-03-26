import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "BundleEnvironment"
)

/// Captures app bundle path, quarantine xattr state, and translocation
/// status for diagnostic purposes. Helps identify when macOS security
/// mechanisms (Gatekeeper Path Randomisation, quarantine flags) interfere
/// with ASWebAuthenticationSession or other system services.
enum BundleEnvironment {

    struct Snapshot {
        let bundlePath: String
        let isTranslocated: Bool
        let hasQuarantineAttribute: Bool
        /// Raw quarantine xattr value (e.g. "0083;...;Safari;...").
        let quarantineValue: String?

        var diagnosticDescription: String {
            var parts = ["bundlePath=\(bundlePath)"]
            parts.append("isTranslocated=\(isTranslocated)")
            parts.append("hasQuarantineXattr=\(hasQuarantineAttribute)")
            if let qv = quarantineValue {
                parts.append("quarantineValue=\(qv)")
            }
            return parts.joined(separator: " ")
        }
    }

    /// Captures the current bundle environment snapshot.
    nonisolated static func capture() -> Snapshot {
        let path = Bundle.main.bundlePath
        let translocated = checkTranslocation(path: path)
        let (hasQuarantine, quarantineValue) = readQuarantineAttribute(path: path)

        return Snapshot(
            bundlePath: path,
            isTranslocated: translocated,
            hasQuarantineAttribute: hasQuarantine,
            quarantineValue: quarantineValue
        )
    }

    /// Writes an `app-environment.json` file containing bundle path,
    /// translocation, and quarantine diagnostics.
    nonisolated static func write(to url: URL) {
        let snapshot = capture()

        var info: [String: Any] = [
            "capturedAt": Date().iso8601String,
            "bundlePath": snapshot.bundlePath,
            "isTranslocated": snapshot.isTranslocated,
            "hasQuarantineAttribute": snapshot.hasQuarantineAttribute,
        ]

        if let qv = snapshot.quarantineValue {
            info["quarantineValue"] = qv
        }

        #if arch(arm64)
        info["architecture"] = "arm64"
        #elseif arch(x86_64)
        info["architecture"] = "x86_64"
        #endif

        if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            info["appVersion"] = version
        }

        let osVersion = ProcessInfo.processInfo.operatingSystemVersion
        info["macOSVersion"] = "\(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"

        guard let data = try? JSONSerialization.data(
            withJSONObject: info,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }

        do {
            try data.write(to: url)
        } catch {
            log.error("Failed to write app environment diagnostics: \(error.localizedDescription)")
        }
    }

    // MARK: - Private

    /// Detects whether the app is running from a translocated path.
    /// Translocated apps run from a randomised path under
    /// `/private/var/folders/.../AppTranslocation/` which can prevent
    /// ASWebAuthenticationSession from communicating with its helper.
    private static func checkTranslocation(path: String) -> Bool {
        path.contains("/AppTranslocation/")
    }

    /// Reads the `com.apple.quarantine` extended attribute from the bundle.
    /// Returns `(true, value)` if present, `(false, nil)` otherwise.
    private static func readQuarantineAttribute(path: String) -> (Bool, String?) {
        let name = "com.apple.quarantine"

        // First call: get the size of the xattr value.
        let size = getxattr(path, name, nil, 0, 0, XATTR_NOFOLLOW)
        guard size > 0 else {
            return (false, nil)
        }

        // Second call: read the value.
        var buffer = [UInt8](repeating: 0, count: size)
        let read = getxattr(path, name, &buffer, size, 0, XATTR_NOFOLLOW)
        guard read > 0 else {
            return (false, nil)
        }

        let value = String(bytes: buffer[..<read], encoding: .utf8)
        return (true, value)
    }
}
