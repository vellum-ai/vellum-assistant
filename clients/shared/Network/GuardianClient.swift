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

    /// Calls `POST /v1/guardian/reset-bootstrap` on the loopback gateway to clear
    /// the bare-metal `guardian-init.lock`, allowing a subsequent `/v1/guardian/init`
    /// to succeed. Used as a recovery primitive when the client has lost its actor
    /// token after an initial bootstrap. The gateway enforces loopback-origin,
    /// bare-metal-mode, and a timing-safe comparison of the caller-supplied
    /// `X-Reset-Bootstrap-Secret` header against the on-disk proof written by
    /// the CLI during hatch. Docker and managed deployments return 403.
    ///
    /// - Parameter secret: The filesystem-secret proof read from
    ///   `VellumPaths.current.resetBootstrapAuthFile`. When `nil` the header is
    ///   omitted and the gateway rejects the request with 403 — callers are
    ///   expected to load the secret via
    ///   `GuardianTokenFileReader.loadResetBootstrapSecret()` before invoking.
    /// - Returns: `true` on success (200), `false` on any failure.
    public func resetBootstrapLock(secret: String?) async -> Bool {
        var extraHeaders: [String: String] = [:]
        if let secret, !secret.isEmpty {
            extraHeaders["x-reset-bootstrap-secret"] = secret
        }
        do {
            let response = try await GatewayHTTPClient.post(
                path: "guardian/reset-bootstrap",
                json: [:],
                extraHeaders: extraHeaders.isEmpty ? nil : extraHeaders,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("resetBootstrapLock failed (HTTP \(response.statusCode))")
                return false
            }
            log.info("Bootstrap lock cleared — client can re-run /v1/guardian/init")
            return true
        } catch {
            log.error("resetBootstrapLock error: \(error.localizedDescription)")
            return false
        }
    }

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
