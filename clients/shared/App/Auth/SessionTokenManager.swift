import Foundation

public extension Notification.Name {
    static let sessionTokenDidChange = Notification.Name("SessionTokenManager.didChange")
}

/// Cross-platform session token storage using Keychain via APIKeyManager.
/// Replaces the macOS-only `/usr/bin/security` CLI approach.
/// Uses provider "session-token" to match the old keychain account name
/// so existing macOS users' stored sessions are preserved after upgrade.
///
/// Also writes the token to `~/.vellum/platform-token` so the daemon can
/// read it for authenticated platform API calls without IPC round-trips.
public enum SessionTokenManager {
    private static let provider = "session-token"

    /// Path to the platform token file the daemon reads.
    private static var platformTokenPath: String {
        platformTokenPath(environment: connectedAssistantEnvironment())
    }

    public static func getToken() -> String? {
        APIKeyManager.shared.getAPIKey(provider: provider)
    }

    public static func setToken(_ token: String) {
        _ = APIKeyManager.shared.setAPIKey(token, provider: provider)
        writePlatformTokenFile(token)
        NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
    }

    public static func deleteToken() {
        _ = APIKeyManager.shared.deleteAPIKey(provider: provider)
        removePlatformTokenFile()
        NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
    }

    // MARK: - Platform token file bridge

    private static func platformTokenPath(environment: [String: String]?) -> String {
        resolveVellumDir(environment: environment) + "/platform-token"
    }

    /// Scope platform-token writes to the active assistant instance when the
    /// current lockfile entry exposes an instanceDir.
    private static func connectedAssistantEnvironment() -> [String: String]? {
        guard let connectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
              let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]],
              let assistant = assistants.first(where: { ($0["assistantId"] as? String) == connectedAssistantId }),
              let resources = assistant["resources"] as? [String: Any],
              let instanceDir = resources["instanceDir"] as? String,
              !instanceDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        return ["BASE_DATA_DIR": instanceDir]
    }

    private static func writePlatformTokenFile(_ token: String) {
        let path = platformTokenPath
        do {
            try token.write(toFile: path, atomically: true, encoding: .utf8)
            // Restrict permissions to owner-only (0600)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: path
            )
        } catch {
            // Best-effort; daemon falls back to bundled catalog if token is unavailable
        }
    }

    private static func removePlatformTokenFile() {
        try? FileManager.default.removeItem(atPath: platformTokenPath)
    }

    public static func getTokenAsync() async -> String? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = getToken()
                continuation.resume(returning: result)
            }
        }
    }

    public static func setTokenAsync(_ token: String) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                _ = APIKeyManager.shared.setAPIKey(token, provider: provider)
                writePlatformTokenFile(token)
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
                }
                continuation.resume()
            }
        }
    }

    public static func deleteTokenAsync() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                _ = APIKeyManager.shared.deleteAPIKey(provider: provider)
                removePlatformTokenFile()
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
                }
                continuation.resume()
            }
        }
    }
}
