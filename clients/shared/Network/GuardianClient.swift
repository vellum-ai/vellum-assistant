import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GuardianClient")

/// Focused client for guardian operations routed through the gateway.
@MainActor
public protocol GuardianClientProtocol {
    func fetchPendingActions(conversationId: String) async -> GuardianActionsPendingResponseMessage?
    func submitDecision(requestId: String, action: String, conversationId: String?) async -> GuardianActionDecisionResponseMessage?
    func bootstrapActorToken(platform: String, deviceId: String) async -> Bool
}

/// Gateway-backed implementation of ``GuardianClientProtocol``.
@MainActor
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
    /// (assistantId, platform, deviceId). Stores credentials in Keychain via
    /// `ActorTokenManager`.
    ///
    /// - Returns: `true` on success, `false` on failure.
    public func bootstrapActorToken(platform: String, deviceId: String) async -> Bool {
        let body: [String: Any] = [
            "platform": platform,
            "deviceId": deviceId
        ]

        do {
            let response = try await GatewayHTTPClient.post(
                path: "guardian/init", json: body, timeout: 15
            )
            guard response.isSuccess else {
                log.error("Access token bootstrap failed (HTTP \(response.statusCode))")
                return false
            }

            let decoded = try JSONDecoder().decode(GuardianBootstrapResponse.self, from: response.data)
            if let refreshToken = decoded.refreshToken,
               let accessTokenExpiresAt = decoded.accessTokenExpiresAt,
               let refreshTokenExpiresAt = decoded.refreshTokenExpiresAt,
               let refreshAfter = decoded.refreshAfter {
                ActorTokenManager.storeCredentials(
                    actorToken: decoded.accessToken,
                    actorTokenExpiresAt: accessTokenExpiresAt,
                    refreshToken: refreshToken,
                    refreshTokenExpiresAt: refreshTokenExpiresAt,
                    refreshAfter: refreshAfter,
                    guardianPrincipalId: decoded.guardianPrincipalId
                )
            } else {
                // Legacy fallback for older runtimes that don't return refresh tokens.
                ActorTokenManager.setToken(decoded.accessToken)
                ActorTokenManager.setGuardianPrincipalId(decoded.guardianPrincipalId)
                ActorTokenManager.clearRefreshMetadata()
            }
            log.info("Access token bootstrap succeeded (isNew=\(decoded.isNew))")
            return true
        } catch {
            log.error("Access token bootstrap error: \(error.localizedDescription)")
            return false
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
/// Accepts both `accessToken` (new) and `actorToken` (legacy) field names.
public struct GuardianBootstrapResponse: Decodable {
    public let guardianPrincipalId: String
    /// The JWT access token — accepts either `accessToken` or legacy `actorToken`.
    public let accessToken: String
    public let accessTokenExpiresAt: Int?
    public let refreshToken: String?
    public let refreshTokenExpiresAt: Int?
    public let refreshAfter: Int?
    public let isNew: Bool

    private enum CodingKeys: String, CodingKey {
        case guardianPrincipalId
        case accessToken
        case actorToken
        case accessTokenExpiresAt
        case actorTokenExpiresAt
        case refreshToken
        case refreshTokenExpiresAt
        case refreshAfter
        case isNew
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guardianPrincipalId = try container.decode(String.self, forKey: .guardianPrincipalId)
        // Accept "accessToken" first, fall back to legacy "actorToken"
        if let token = try container.decodeIfPresent(String.self, forKey: .accessToken) {
            accessToken = token
        } else {
            accessToken = try container.decode(String.self, forKey: .actorToken)
        }
        // Accept "accessTokenExpiresAt" first, fall back to legacy "actorTokenExpiresAt"
        if let expiresAt = try container.decodeIfPresent(Int.self, forKey: .accessTokenExpiresAt) {
            accessTokenExpiresAt = expiresAt
        } else {
            accessTokenExpiresAt = try container.decodeIfPresent(Int.self, forKey: .actorTokenExpiresAt)
        }
        refreshToken = try container.decodeIfPresent(String.self, forKey: .refreshToken)
        refreshTokenExpiresAt = try container.decodeIfPresent(Int.self, forKey: .refreshTokenExpiresAt)
        refreshAfter = try container.decodeIfPresent(Int.self, forKey: .refreshAfter)
        isNew = try container.decode(Bool.self, forKey: .isNew)
    }
}
