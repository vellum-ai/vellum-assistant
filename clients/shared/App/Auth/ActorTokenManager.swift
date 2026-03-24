import Foundation

/// Cross-platform JWT access token storage using credential storage via APIKeyManager.
/// The access token (JWT) serves as both authentication and identity for
/// HTTP requests to the runtime, transmitted as `Authorization: Bearer <jwt>`.
///
/// Note: Storage keys are intentionally unchanged from the original
/// "actor-token" naming to avoid orphaning existing credentials on upgrade.
///
/// Follows the same credential storage pattern as SessionTokenManager.
public enum ActorTokenManager {
    private static let provider = "actor-token"
    private static let guardianPrincipalIdProvider = "actor-token-guardian-principal-id"
    private static let refreshTokenProvider = "actor-refresh-token"
    private static let actorTokenExpiresAtProvider = "actor-token-expires-at"
    private static let refreshTokenExpiresAtProvider = "refresh-token-expires-at"
    private static let refreshAfterProvider = "actor-token-refresh-after"

    public static func getToken() -> String? {
        APIKeyManager.shared.getAPIKey(provider: provider)
    }

    public static func setToken(_ token: String) {
        _ = APIKeyManager.shared.setAPIKey(token, provider: provider)
    }

    public static func deleteToken() {
        deleteAllCredentials()
    }

    /// Whether an actor token is currently stored.
    public static var hasToken: Bool {
        getToken() != nil
    }

    // MARK: - Refresh Token

    public static func getRefreshToken() -> String? {
        APIKeyManager.shared.getAPIKey(provider: refreshTokenProvider)
    }

    public static func setRefreshToken(_ token: String) {
        _ = APIKeyManager.shared.setAPIKey(token, provider: refreshTokenProvider)
    }

    public static func deleteRefreshToken() {
        _ = APIKeyManager.shared.deleteAPIKey(provider: refreshTokenProvider)
    }

    /// Clear all refresh-related metadata (token, expiry, refreshAfter).
    /// Used when a bootstrap response lacks refresh fields so stale values
    /// from prior pairings don't trigger invalid refresh attempts.
    public static func clearRefreshMetadata() {
        _ = APIKeyManager.shared.deleteAPIKey(provider: refreshTokenProvider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: refreshTokenExpiresAtProvider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: refreshAfterProvider)
    }

    // MARK: - Expiry Timestamps

    public static func getActorTokenExpiresAt() -> Int? {
        guard let str = APIKeyManager.shared.getAPIKey(provider: actorTokenExpiresAtProvider) else { return nil }
        return Int(str)
    }

    public static func setActorTokenExpiresAt(_ epoch: Int) {
        _ = APIKeyManager.shared.setAPIKey(String(epoch), provider: actorTokenExpiresAtProvider)
    }

    public static func getRefreshTokenExpiresAt() -> Int? {
        guard let str = APIKeyManager.shared.getAPIKey(provider: refreshTokenExpiresAtProvider) else { return nil }
        return Int(str)
    }

    public static func setRefreshTokenExpiresAt(_ epoch: Int) {
        _ = APIKeyManager.shared.setAPIKey(String(epoch), provider: refreshTokenExpiresAtProvider)
    }

    public static func getRefreshAfter() -> Int? {
        guard let str = APIKeyManager.shared.getAPIKey(provider: refreshAfterProvider) else { return nil }
        return Int(str)
    }

    public static func setRefreshAfter(_ epoch: Int) {
        _ = APIKeyManager.shared.setAPIKey(String(epoch), provider: refreshAfterProvider)
    }

    // MARK: - Credential Bundle

    /// Store the full credential set from bootstrap/pairing/refresh response.
    public static func storeCredentials(
        actorToken: String,
        actorTokenExpiresAt: Int,
        refreshToken: String,
        refreshTokenExpiresAt: Int,
        refreshAfter: Int,
        guardianPrincipalId: String? = nil
    ) {
        setToken(actorToken)
        setActorTokenExpiresAt(actorTokenExpiresAt)
        setRefreshToken(refreshToken)
        setRefreshTokenExpiresAt(refreshTokenExpiresAt)
        setRefreshAfter(refreshAfter)
        if let guardianPrincipalId {
            setGuardianPrincipalId(guardianPrincipalId)
        }
    }

    /// Delete all credentials (used during unpair/logout).
    public static func deleteAllCredentials() {
        _ = APIKeyManager.shared.deleteAPIKey(provider: provider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: guardianPrincipalIdProvider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: refreshTokenProvider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: actorTokenExpiresAtProvider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: refreshTokenExpiresAtProvider)
        _ = APIKeyManager.shared.deleteAPIKey(provider: refreshAfterProvider)
    }

    // MARK: - Async Token Resolution

    /// Waits for a non-empty token to become available, polling at 500ms intervals.
    /// Returns the token once available, or `nil` if the timeout elapses.
    /// Use this in callsites that fire during the bootstrap window (e.g. on
    /// daemonDidReconnect) where the JWT may not yet be populated.
    public static func waitForToken(timeout: TimeInterval = 10) async -> String? {
        if let token = getToken(), !token.isEmpty { return token }

        let deadline = CFAbsoluteTimeGetCurrent() + timeout
        while CFAbsoluteTimeGetCurrent() < deadline {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return nil }
            if let token = getToken(), !token.isEmpty { return token }
        }
        return nil
    }

    // MARK: - Proactive Refresh Checks

    /// Whether the access token needs proactive refresh.
    public static var needsProactiveRefresh: Bool {
        guard let refreshAfter = getRefreshAfter() else { return false }
        return Int(Date().timeIntervalSince1970 * 1000) >= refreshAfter
    }

    /// Whether the refresh token is expired.
    public static var isRefreshTokenExpired: Bool {
        guard let expiresAt = getRefreshTokenExpiresAt() else { return true }
        return Int(Date().timeIntervalSince1970 * 1000) >= expiresAt
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

    /// Decode the base64url-encoded JWT payload and extract the
    /// `guardianPrincipalId` claim. JWT format: header.payload.signature
    static func extractGuardianPrincipalIdFromToken(_ token: String) -> String? {
        let parts = token.split(separator: ".")
        // JWT payload is the second segment (index 1)
        guard parts.count >= 2 else { return nil }
        let payloadSegment = parts[1]

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
