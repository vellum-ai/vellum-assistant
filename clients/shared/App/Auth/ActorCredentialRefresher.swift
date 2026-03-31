import Foundation

/// Shared credential refresher. Calls POST /v1/guardian/refresh
/// through `GatewayHTTPClient.post(skipRetry: true)`, updates credential
/// storage via ActorTokenManager, and handles terminal errors that require
/// re-pairing.
///
/// The `skipRetry` flag bypasses the 401 retry interceptor to prevent
/// recursive refresh attempts when the refresh endpoint itself returns 401.
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
                timeout: 15,
                skipRetry: true
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

            // Check for terminal errors in the response body first,
            // so specific reasons (e.g. "refresh_reuse_detected") are
            // preserved in logs rather than being shadowed by the generic
            // "refresh_unauthorized" from the 401 status check below.
            if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let error = json["error"] as? String {
                let terminalErrors = ["refresh_reuse_detected", "revoked", "device_binding_mismatch", "refresh_invalid", "refresh_expired"]
                if terminalErrors.contains(error) {
                    return .terminalError(reason: error)
                }
            }

            // A 401 on the refresh endpoint means the refresh token itself
            // is rejected — retrying with the same token will never succeed.
            if response.statusCode == 401 {
                return .terminalError(reason: "refresh_unauthorized")
            }

            return .transientError
        } catch {
            return .transientError
        }
    }
}
