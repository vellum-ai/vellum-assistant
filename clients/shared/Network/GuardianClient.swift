import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "GuardianClient")

/// Focused client for guardian operations routed through the gateway.
public protocol GuardianClientProtocol {
    func fetchPendingActions(conversationId: String) async -> GuardianActionsPendingResponseMessage?
    func submitDecision(requestId: String, action: String, conversationId: String?) async -> GuardianActionDecisionResponseMessage?
    func bootstrapActorToken(platform: String, deviceId: String) async -> Bool
}

/// Gateway-backed implementation of ``GuardianClientProtocol``.
public struct GuardianClient: GuardianClientProtocol {
    nonisolated public init() {}

    public func fetchPendingActions(conversationId: String) async -> GuardianActionsPendingResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/guardian-actions/pending",
                params: ["conversationId": conversationId],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchPendingActions failed (HTTP \(response.statusCode))")
                return nil
            }
            let decoded = try JSONDecoder().decode(PendingActionsHTTPResponse.self, from: response.data)
            return GuardianActionsPendingResponseMessage(
                conversationId: decoded.conversationId,
                prompts: decoded.prompts
            )
        } catch {
            log.error("fetchPendingActions error: \(error.localizedDescription)")
            return nil
        }
    }

    public func submitDecision(requestId: String, action: String, conversationId: String? = nil) async -> GuardianActionDecisionResponseMessage? {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
                "action": action,
            ]
            if let conversationId { body["conversationId"] = conversationId }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/guardian-actions/decision", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("submitDecision failed (HTTP \(response.statusCode))")
                return GuardianActionDecisionResponseMessage(
                    applied: false,
                    reason: "HTTP \(response.statusCode)",
                    resolverFailureReason: nil,
                    requestId: requestId,
                    userText: nil
                )
            }
            return try JSONDecoder().decode(GuardianActionDecisionResponseMessage.self, from: response.data)
        } catch {
            log.error("submitDecision error: \(error.localizedDescription)")
            return GuardianActionDecisionResponseMessage(
                applied: false,
                reason: error.localizedDescription,
                resolverFailureReason: nil,
                requestId: requestId,
                userText: nil
            )
        }
    }

    // MARK: - Actor Token Bootstrap

    /// Calls `POST /v1/guardian/init` to obtain a JWT access token bound to
    /// (assistantId, platform, deviceId). Stores credentials in credential storage via
    /// `ActorTokenManager`.
    ///
    /// - Returns: `true` on success, `false` on failure.
    public func bootstrapActorToken(platform: String, deviceId: String) async -> Bool {
        let body: [String: Any] = [
            "platform": platform,
            "deviceId": deviceId
        ]

        // Generate a one-time bootstrap secret in memory (never stored on disk).
        let bootstrapSecret = UUID().uuidString
        let extraHeaders = ["x-bootstrap-secret": bootstrapSecret]

        do {
            let response = try await GatewayHTTPClient.post(
                path: "guardian/init", json: body, extraHeaders: extraHeaders, timeout: 15
            )

            // If the gateway rejects bootstrap with "Bootstrap already completed"
            // (403), the guardian-init.lock file from a previous bootstrap is
            // blocking re-issuance. Remove it so the next retry can succeed.
            // This happens when credentials are wiped (terminal refresh error,
            // daemon instance change) but the lock file persists.
            if response.statusCode == 403 {
                Self.removeBootstrapLockFileIfNeeded(responseData: response.data)
                log.error("Access token bootstrap failed (HTTP 403)")
                return false
            }

            guard response.isSuccess else {
                log.error("Access token bootstrap failed (HTTP \(response.statusCode))")
                return false
            }

            let decoded = try JSONDecoder().decode(GuardianBootstrapResponse.self, from: response.data)
            ActorTokenManager.storeCredentials(
                actorToken: decoded.accessToken,
                actorTokenExpiresAt: decoded.accessTokenExpiresAt,
                refreshToken: decoded.refreshToken,
                refreshTokenExpiresAt: decoded.refreshTokenExpiresAt,
                refreshAfter: decoded.refreshAfter,
                guardianPrincipalId: decoded.guardianPrincipalId
            )
            log.info("Access token bootstrap succeeded (isNew=\(decoded.isNew))")
            return true
        } catch {
            log.error("Access token bootstrap error: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Bootstrap Lock File Recovery

    /// Removes the `guardian-init.lock` file when the gateway rejects
    /// bootstrap with "Bootstrap already completed". The lock persists
    /// from a prior successful bootstrap, but if the credentials were
    /// wiped (terminal refresh error, instance change), the lock must
    /// be cleared to allow re-issuance.
    private static func removeBootstrapLockFileIfNeeded(responseData: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
              let error = json["error"] as? String,
              error == "Bootstrap already completed" else {
            return
        }

        let rootDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum")
        let lockPath = rootDir.appendingPathComponent("guardian-init.lock")

        guard FileManager.default.fileExists(atPath: lockPath.path) else { return }

        do {
            try FileManager.default.removeItem(at: lockPath)
            log.info("Removed guardian-init.lock to allow re-bootstrap")
        } catch {
            log.error("Failed to remove guardian-init.lock: \(error.localizedDescription)")
        }
    }

    // MARK: - Response Shapes

    private struct PendingActionsHTTPResponse: Decodable {
        let conversationId: String?
        let prompts: [GuardianDecisionPromptWire]
    }
}

// MARK: - Guardian Bootstrap Response

/// Response from `POST /v1/guardian/init`.
public struct GuardianBootstrapResponse: Decodable {
    public let guardianPrincipalId: String
    public let accessToken: String
    public let accessTokenExpiresAt: Int
    public let refreshToken: String
    public let refreshTokenExpiresAt: Int
    public let refreshAfter: Int
    public let isNew: Bool
}
