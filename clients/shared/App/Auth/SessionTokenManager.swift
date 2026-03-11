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
/// read it for authenticated platform API calls without round-trips.
public enum SessionTokenManager {
    private static let provider = "session-token"

    /// Path to the platform token file the daemon reads.
    private static var platformTokenPath: String {
        connectedAssistantPlatformTokenPath() ?? defaultPlatformTokenPath()
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

    /// Scope platform-token writes to the active assistant instance when the
    /// current lockfile entry exposes assistant-specific storage paths.
    private static func connectedAssistantPlatformTokenPath() -> String? {
        guard let connectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
              let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]],
              let assistant = assistants.first(where: { ($0["assistantId"] as? String) == connectedAssistantId }) else {
            return nil
        }

        if let baseDataDir = assistant["baseDataDir"] as? String {
            let trimmed = baseDataDir.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed + "/platform-token"
            }
        }

        if let resources = assistant["resources"] as? [String: Any],
           let instanceDir = resources["instanceDir"] as? String {
            let trimmed = instanceDir.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed + "/.vellum/platform-token"
            }
        }

        return nil
    }

    private static func defaultPlatformTokenPath() -> String {
        let launchEnvironment = ProcessInfo.processInfo.environment
        if let baseDir = launchEnvironment["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !baseDir.isEmpty {
            let resolved = baseDir == "~"
                ? NSHomeDirectory()
                : (baseDir.hasPrefix("~/")
                    ? NSHomeDirectory() + "/" + String(baseDir.dropFirst(2))
                    : baseDir)
            return resolved + "/.vellum/platform-token"
        }
        return NSHomeDirectory() + "/.vellum/platform-token"
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
