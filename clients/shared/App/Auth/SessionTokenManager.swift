import Foundation

public extension Notification.Name {
    static let sessionTokenDidChange = Notification.Name("SessionTokenManager.didChange")
}

/// Cross-platform session token storage using Keychain via APIKeyManager.
/// Replaces the macOS-only `/usr/bin/security` CLI approach.
public enum SessionTokenManager {
    private static let provider = "platform-session-token"

    public static func getToken() -> String? {
        APIKeyManager.shared.getAPIKey(provider: provider)
    }

    public static func setToken(_ token: String) {
        _ = APIKeyManager.shared.setAPIKey(token, provider: provider)
        NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
    }

    public static func deleteToken() {
        _ = APIKeyManager.shared.deleteAPIKey(provider: provider)
        NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
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
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
                }
                continuation.resume()
            }
        }
    }
}
