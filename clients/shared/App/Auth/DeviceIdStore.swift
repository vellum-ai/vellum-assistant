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

        let deviceFile = VellumPaths.current.deviceIdFile
        let vellumDir = deviceFile.deletingLastPathComponent()

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
        let migratingFromLegacy: Bool
        var deviceId: String
        if let legacyId = UserDefaults.standard.string(forKey: legacyUserDefaultsKey),
           !legacyId.isEmpty {
            deviceId = legacyId
            migratingFromLegacy = true
        } else if let lockfileId = Self.installationIdFromLockfile() {
            // 2b. Migrate from lockfile installationId (mirrors daemon 003-seed-device-id).
            deviceId = lockfileId
            migratingFromLegacy = false
        } else {
            // 3. No existing ID anywhere — generate a fresh one.
            deviceId = UUID().uuidString.lowercased()
            migratingFromLegacy = false
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

        // Only clean up the legacy UserDefaults key after the file write succeeds,
        // so we don't lose the ID if the write fails (permissions, full disk, etc.).
        if migratingFromLegacy,
           let data = try? Data(contentsOf: deviceFile),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let writtenId = json["deviceId"] as? String,
           writtenId == deviceId {
            UserDefaults.standard.removeObject(forKey: legacyUserDefaultsKey)
        }

        cached = deviceId
        return deviceId
    }

    // MARK: - Lockfile Migration

    /// Reads the most recent `installationId` from the legacy lockfile,
    /// mirroring the daemon's `003-seed-device-id` migration so the same
    /// legacy ID is preserved regardless of whether macOS or daemon starts first.
    private static func installationIdFromLockfile() -> String? {
        var lockJSON: [String: Any]?
        for candidate in VellumPaths.current.lockfileCandidates {
            guard let data = try? Data(contentsOf: candidate),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            lockJSON = json
            break
        }
        guard let lockJSON else { return nil }

        guard let assistants = lockJSON["assistants"] as? [[String: Any]],
              !assistants.isEmpty else {
            return nil
        }

        // Filter to entries with a non-empty installationId.
        let withInstallId = assistants.filter { entry in
            guard let id = entry["installationId"] as? String, !id.isEmpty else { return false }
            return true
        }
        guard !withInstallId.isEmpty else { return nil }

        // Sort by hatchedAt descending to pick the most recent.
        // Use a formatter with fractional seconds since CLI writes
        // timestamps via `new Date().toISOString()` (e.g. "...00.000Z").
        let sorted = withInstallId.sorted { a, b in
            let dateA = (a["hatchedAt"] as? String).flatMap(\.iso8601Date) ?? .distantPast
            let dateB = (b["hatchedAt"] as? String).flatMap(\.iso8601Date) ?? .distantPast
            return dateA > dateB
        }

        return sorted.first?["installationId"] as? String
    }
}
