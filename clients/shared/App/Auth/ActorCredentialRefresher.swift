import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ActorCredentialRefresher")

/// Performs credential refresh by calling `POST /v1/guardian/refresh` directly
/// via `URLSession`, bypassing `GatewayHTTPClient` entirely to avoid recursive
/// 401 retry loops.
///
/// The request includes the current access token (which may be expired) as a
/// Bearer header — the gateway validates signature and policy but relaxes the
/// expiration check (`allowExpired: true`).
public class ActorCredentialRefresher {

    public enum RefreshResult {
        case success
        case terminalError(reason: String) // requires re-pair
        case transientError // retry later
    }

    /// Resolves the gateway base URL for the current connection.
    ///
    /// - macOS: Reads from the lockfile via `LockfilePaths.resolveGatewayUrl()`.
    /// - iOS: Reads from UserDefaults (`gateway_base_url`).
    private static func resolveGatewayBaseURL() -> String? {
        #if os(macOS)
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        return LockfilePaths.resolveGatewayUrl(connectedAssistantId: connectedId)
        #elseif os(iOS)
        return UserDefaults.standard.string(forKey: "gateway_base_url")
        #else
        return nil
        #endif
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

        guard let baseURL = resolveGatewayBaseURL() else {
            log.error("Cannot resolve gateway base URL for credential refresh")
            return .transientError
        }

        guard let url = URL(string: "\(baseURL)/v1/guardian/refresh/") else {
            log.error("Invalid refresh URL from base: \(baseURL, privacy: .public)")
            return .transientError
        }

        let body: [String: Any] = ["refreshToken": refreshToken, "platform": platform, "deviceId": deviceId]

        do {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            // The gateway requires a Bearer token on the refresh route, but
            // validates it with `allowExpired: true` — so an expired JWT is
            // accepted. Send whatever access token we currently have.
            if let accessToken = ActorTokenManager.getToken(), !accessToken.isEmpty {
                request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            }

            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await URLSession.shared.data(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1

            if (200..<300).contains(statusCode) {
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

            // Check for terminal errors in the response body first,
            // so specific reasons (e.g. "refresh_reuse_detected") are
            // preserved in logs rather than being shadowed by the generic
            // "refresh_unauthorized" from the 401 status check below.
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let error = json["error"] as? String {
                let terminalErrors = ["refresh_reuse_detected", "revoked", "device_binding_mismatch", "refresh_invalid", "refresh_expired"]
                if terminalErrors.contains(error) {
                    return .terminalError(reason: error)
                }
            }

            // A 401 on the refresh endpoint means the refresh token itself
            // is rejected — retrying with the same token will never succeed.
            if statusCode == 401 {
                return .terminalError(reason: "refresh_unauthorized")
            }

            return .transientError
        } catch {
            log.warning("Credential refresh network error: \(error.localizedDescription, privacy: .public)")
            return .transientError
        }
    }
}
