#if os(macOS)
import Foundation

/// Reads or creates a per-device UUID stored at ~/.vellum/device.json.
/// This file is shared with the daemon (TypeScript), so both runtimes
/// use the same device identifier for telemetry and platform registration.
///
/// The file is a JSON object: { "deviceId": "<uuid>", ... }
/// Additional per-device metadata can be added alongside deviceId in the future.
///
/// On first access, migrates any existing UUID from UserDefaults
/// (legacy LocalInstallationIdStore key) into the file to preserve
/// continuity for existing installations.
public enum DeviceIdStore {
    private static let lock = NSLock()
    private static var cached: String?
    private static let legacyUserDefaultsKey = "vellum_local_installation_id"

    /// Returns the device ID, reading from ~/.vellum/device.json or creating it
    /// if it doesn't exist. Thread-safe and cached after first access.
    ///
    /// Migration: if the file has no deviceId, checks UserDefaults for the
    /// legacy key and seeds the file with that value before cleaning up
    /// the UserDefaults entry.
    public static func getOrCreate() -> String {
        lock.lock()
        defer { lock.unlock() }

        if let cached { return cached }

        let home = FileManager.default.homeDirectoryForCurrentUser
        let vellumDir = home.appendingPathComponent(".vellum", isDirectory: true)
        let deviceFile = vellumDir.appendingPathComponent("device.json")

        // 1. Try to read existing file (daemon or a previous run may have created it).
        if let data = try? Data(contentsOf: deviceFile),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let existingId = json["deviceId"] as? String,
           !existingId.isEmpty {
            cached = existingId
            // Clean up legacy UserDefaults if still present.
            UserDefaults.standard.removeObject(forKey: legacyUserDefaultsKey)
            return existingId
        }

        // 2. Migrate from legacy UserDefaults (LocalInstallationIdStore).
        var deviceId: String
        if let legacyId = UserDefaults.standard.string(forKey: legacyUserDefaultsKey),
           !legacyId.isEmpty {
            deviceId = legacyId
            // Clean up legacy key — the file is now the source of truth.
            UserDefaults.standard.removeObject(forKey: legacyUserDefaultsKey)
        } else {
            // 3. No existing ID anywhere — generate a fresh one.
            deviceId = UUID().uuidString.lowercased()
        }

        // Persist to the shared file, preserving any other fields.
        var existing: [String: Any] = [:]
        if let data = try? Data(contentsOf: deviceFile),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            existing = json
        }
        existing["deviceId"] = deviceId

        try? FileManager.default.createDirectory(at: vellumDir, withIntermediateDirectories: true)
        if let jsonData = try? JSONSerialization.data(withJSONObject: existing, options: [.prettyPrinted, .sortedKeys]) {
            var output = jsonData
            output.append(contentsOf: "\n".utf8)
            try? output.write(to: deviceFile, options: .atomic)
        }
        cached = deviceId
        return deviceId
    }
}
#endif
