import Foundation

/// Cross-platform actor-token storage using Keychain via APIKeyManager.
/// The actor token is an HMAC-signed credential that binds an assistant,
/// platform, device, and guardian principal. It is transmitted as
/// `X-Actor-Token` on HTTP requests to the runtime.
///
/// Follows the same Keychain persistence pattern as SessionTokenManager.
public enum ActorTokenManager {
    private static let provider = "actor-token"
    private static let guardianPrincipalIdProvider = "actor-token-guardian-principal-id"

    public static func getToken() -> String? {
        APIKeyManager.shared.getAPIKey(provider: provider)
    }

    public static func setToken(_ token: String) {
        _ = APIKeyManager.shared.setAPIKey(token, provider: provider)
    }

    public static func deleteToken() {
        _ = APIKeyManager.shared.deleteAPIKey(provider: provider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: guardianPrincipalIdProvider)
    }

    /// Whether an actor token is currently stored.
    public static var hasToken: Bool {
        getToken() != nil
    }

    // MARK: - Guardian Principal ID

    /// Store the guardian principal ID alongside the actor token.
    public static func setGuardianPrincipalId(_ id: String) {
        _ = APIKeyManager.shared.setAPIKey(id, provider: guardianPrincipalIdProvider)
    }

    /// Retrieve the guardian principal ID. First checks the explicitly stored
    /// value, then falls back to decoding the actor token's JWT payload.
    public static func getGuardianPrincipalId() -> String? {
        if let stored = APIKeyManager.shared.getAPIKey(provider: guardianPrincipalIdProvider) {
            return stored
        }
        // Fallback: decode the actor token JWT payload (base64url-encoded JSON
        // claims in the first segment before the '.' separator).
        guard let token = getToken() else { return nil }
        return Self.extractGuardianPrincipalIdFromToken(token)
    }

    /// Decode the base64url-encoded JWT payload from an actor token and
    /// extract the `guardianPrincipalId` claim.
    static func extractGuardianPrincipalIdFromToken(_ token: String) -> String? {
        let parts = token.split(separator: ".", maxSplits: 2)
        guard let payloadSegment = parts.first else { return nil }

        // base64url -> base64
        var base64 = String(payloadSegment)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Pad to multiple of 4
        let remainder = base64.count % 4
        if remainder != 0 {
            base64.append(contentsOf: String(repeating: "=", count: 4 - remainder))
        }

        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let principalId = json["guardianPrincipalId"] as? String else {
            return nil
        }
        return principalId
    }
}
