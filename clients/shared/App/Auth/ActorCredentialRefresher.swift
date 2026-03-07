import Foundation

/// Shared credential refresher. Calls POST /v1/guardian/refresh
/// through the gateway, updates Keychain via ActorTokenManager, and handles
/// terminal errors that require re-pairing.
public class ActorCredentialRefresher {

    public enum RefreshResult {
        case success
        case terminalError(reason: String) // requires re-pair
        case transientError // retry later
    }

    /// Attempts a single refresh. Thread-safe via @MainActor or serial dispatch.
    /// `baseURL` is the gateway URL (e.g. https://gateway.example.com).
    /// `bearerToken` is the legacy runtime bearer (used only as fallback if no JWT yet).
    public static func refresh(baseURL: String, bearerToken: String?, platform: String, deviceId: String) async -> RefreshResult {
        guard let refreshToken = ActorTokenManager.getRefreshToken() else {
            return .terminalError(reason: "no_refresh_token")
        }

        // Don't attempt refresh if refresh token is already expired
        if ActorTokenManager.isRefreshTokenExpired {
            return .terminalError(reason: "refresh_token_expired")
        }

        guard let url = URL(string: "\(baseURL)/v1/guardian/refresh") else {
            return .transientError
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        // Use the JWT access token as the sole Authorization bearer.
        // Falls back to the legacy runtime bearer token if no JWT is available.
        if let accessToken = ActorTokenManager.getToken(), !accessToken.isEmpty {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        } else if let token = bearerToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let body: [String: Any] = ["refreshToken": refreshToken, "platform": platform, "deviceId": deviceId]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else {
                return .transientError
            }

            if (200..<300).contains(http.statusCode) {
                guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
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
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
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
