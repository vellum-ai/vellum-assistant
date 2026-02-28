import Foundation

/// Cross-platform actor-token storage using Keychain via APIKeyManager.
/// The actor token is an HMAC-signed credential that binds an assistant,
/// platform, device, and guardian principal. It is transmitted as
/// `X-Actor-Token` on HTTP requests to the runtime.
///
/// Follows the same Keychain persistence pattern as SessionTokenManager.
public enum ActorTokenManager {
    private static let provider = "actor-token"

    public static func getToken() -> String? {
        APIKeyManager.shared.getAPIKey(provider: provider)
    }

    public static func setToken(_ token: String) {
        _ = APIKeyManager.shared.setAPIKey(token, provider: provider)
    }

    public static func deleteToken() {
        _ = APIKeyManager.shared.deleteAPIKey(provider: provider)
    }

    /// Whether an actor token is currently stored.
    public static var hasToken: Bool {
        getToken() != nil
    }
}
