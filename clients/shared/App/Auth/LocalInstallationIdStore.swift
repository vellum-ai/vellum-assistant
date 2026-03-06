import Foundation

/// Generates and persists an install-scoped random UUID for local assistant registration.
/// This ID is stable across app launches but unique per installation.
/// Do NOT use PairingQRCodeSheet.computeHostId() — that derives from hardware.
public enum LocalInstallationIdStore {
    private static let key = "vellum_local_installation_id"

    /// Returns the persisted installation ID, generating one on first access.
    public static func getOrCreate() -> String {
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let newId = UUID().uuidString.lowercased()
        UserDefaults.standard.set(newId, forKey: key)
        return newId
    }
}
