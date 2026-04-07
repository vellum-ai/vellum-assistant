import Foundation

public extension Notification.Name {
    static let sessionTokenDidChange = Notification.Name("SessionTokenManager.didChange")
}

/// Cross-platform session token storage using credential storage via APIKeyManager.
/// Replaces the macOS-only `/usr/bin/security` CLI approach.
/// Uses provider "session-token" to match the old credential storage account name
/// so existing macOS users' stored sessions are preserved after upgrade.
///
/// Also writes the token to `~/.config/vellum/platform-token` (XDG path)
/// and to the instance-scoped path so the daemon and CLI can read it for
/// authenticated platform API calls without round-trips.
public enum SessionTokenManager {
    private static let provider = "session-token"

    /// Path to the platform token file the daemon reads.
    /// For local assistants with a known data directory, writes to the
    /// instance-scoped path. Otherwise uses the XDG-compliant shared path.
    private static var platformTokenPath: String {
        connectedAssistantPlatformTokenPath() ?? xdgPlatformTokenPath()
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
        #if os(macOS)
        guard let connectedAssistantId = LockfileAssistant.loadActiveAssistantId(),
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
        #else
        return nil
        #endif
    }

    /// XDG-compliant shared path (~/.config/vellum/platform-token).
    /// Used by the CLI and desktop app as the canonical token location.
    private static func xdgPlatformTokenPath() -> String {
        let launchEnvironment = ProcessInfo.processInfo.environment
        let configHome: String
        if let xdg = launchEnvironment["XDG_CONFIG_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !xdg.isEmpty {
            configHome = xdg
        } else {
            configHome = NSHomeDirectory() + "/.config"
        }
        return configHome + "/vellum/platform-token"
    }

    private static func writePlatformTokenFile(_ token: String) {
        let paths = [platformTokenPath, xdgPlatformTokenPath()]
        for path in Set(paths) {
            do {
                let dir = (path as NSString).deletingLastPathComponent
                try FileManager.default.createDirectory(
                    atPath: dir,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
                try token.write(toFile: path, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o600],
                    ofItemAtPath: path
                )
            } catch {
                // Best-effort; daemon falls back to bundled catalog if token is unavailable
            }
        }
    }

    private static func removePlatformTokenFile() {
        let paths = [platformTokenPath, xdgPlatformTokenPath()]
        for path in Set(paths) {
            try? FileManager.default.removeItem(atPath: path)
        }
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
