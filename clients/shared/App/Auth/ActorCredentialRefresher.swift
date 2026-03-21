import Foundation

/// Shared credential refresher. Calls POST /v1/guardian/refresh
/// through the gateway via `GatewayHTTPClient`, updates Keychain via
/// ActorTokenManager, and handles terminal errors that require re-pairing.
public class ActorCredentialRefresher {

    public enum RefreshResult {
        case success
        case terminalError(reason: String) // requires re-pair
        case transientError // retry later
    }

    /// Attempts a single credential refresh via the gateway.
    ///
    /// - Parameters:
    ///   - platform: Platform identifier ("macos" or "ios").
    ///   - deviceId: Stable device identifier for device binding.
    public static func refresh(platform: String, deviceId: String) async -> RefreshResult {
        guard let refreshToken = ActorTokenManager.getRefreshToken() else {
            return .terminalError(reason: "no_refresh_token")
        }

        // Don't attempt refresh if refresh token is already expired
        if ActorTokenManager.isRefreshTokenExpired {
            return .terminalError(reason: "refresh_token_expired")
        }

        let body: [String: Any] = ["refreshToken": refreshToken, "platform": platform, "deviceId": deviceId]

        do {
            let response = try await GatewayHTTPClient.post(
                path: "guardian/refresh",
                json: body,
                timeout: 15
            )

            if response.isSuccess {
                guard let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                      let newRefreshToken = json["refreshToken"] as? String,
                      let refreshTokenExpiresAt = json["refreshTokenExpiresAt"] as? Int,
                      let refreshAfter = json["refreshAfter"] as? Int else {
                    return .transientError
                }

                // Accept "accessTokenExpiresAt" (new) or legacy "actorTokenExpiresAt"
                guard let accessTokenExpiresAt = (json["accessTokenExpiresAt"] as? Int) ?? (json["actorTokenExpiresAt"] as? Int) else {
                    return .transientError
                }

                // Accept either "accessToken" (new) or "actorToken" (legacy) field name
                let newAccessToken = (json["accessToken"] as? String) ?? (json["actorToken"] as? String)
                guard let token = newAccessToken else {
                    return .transientError
                }

                ActorTokenManager.storeCredentials(
                    actorToken: token,
                    actorTokenExpiresAt: accessTokenExpiresAt,
                    refreshToken: newRefreshToken,
                    refreshTokenExpiresAt: refreshTokenExpiresAt,
                    refreshAfter: refreshAfter
                )

                return .success
            }

            // Check for terminal errors
            if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let error = json["error"] as? String {
                let terminalErrors = ["refresh_reuse_detected", "revoked", "device_binding_mismatch", "refresh_invalid", "refresh_expired"]
                if terminalErrors.contains(error) {
                    return .terminalError(reason: error)
                }
            }

            return .transientError
        } catch {
            return .transientError
        }
    }
}
