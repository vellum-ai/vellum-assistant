import Foundation

/// Generates and persists an install-scoped random UUID for local assistant registration.
/// This ID is stable across app launches but unique per installation.
/// Do NOT use PairingQRCodeSheet.computeHostId() — that derives from hardware.
public enum LocalInstallationIdStore {
    private static let key = "vellum_local_installation_id"
    private static let lock = NSLock()

    /// Returns the persisted installation ID, generating one on first access.
    /// Uses NSLock to prevent concurrent first-launch calls from generating different UUIDs.
    public static func getOrCreate() -> String {
        lock.lock()
        defer { lock.unlock() }
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let newId = UUID().uuidString.lowercased()
        UserDefaults.standard.set(newId, forKey: key)
        return newId
    }
}
