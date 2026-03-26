import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TrustRuleClient")

/// Focused client for trust rule management operations routed through the gateway.
public protocol TrustRuleClientProtocol {
    func fetchTrustRules() async throws -> [TrustRuleItem]
    func addTrustRule(
        toolName: String,
        pattern: String,
        scope: String,
        decision: String,
        allowHighRisk: Bool?,
        executionTarget: String?
    ) async throws
    func removeTrustRule(id: String) async throws
    func updateTrustRule(
        id: String,
        tool: String?,
        pattern: String?,
        scope: String?,
        decision: String?,
        priority: Int?
    ) async throws
}

/// Gateway-backed implementation of ``TrustRuleClientProtocol``.
public struct TrustRuleClient: TrustRuleClientProtocol {
    nonisolated public init() {}

    enum TrustRuleClientError: LocalizedError {
        case httpError(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .httpError(let statusCode):
                return "Trust rule request failed (HTTP \(statusCode))"
            }
        }
    }

    private struct TrustRulesResponse: Decodable {
        let rules: [TrustRuleItem]
    }

    public func fetchTrustRules() async throws -> [TrustRuleItem] {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/trust-rules/manage", timeout: 10
        )
        guard response.isSuccess else {
            log.error("fetchTrustRules failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.httpError(statusCode: response.statusCode)
        }
        return try JSONDecoder().decode(TrustRulesResponse.self, from: response.data).rules
    }

    public func addTrustRule(
        toolName: String,
        pattern: String,
        scope: String,
        decision: String,
        allowHighRisk: Bool? = nil,
        executionTarget: String? = nil
    ) async throws {
        var body: [String: Any] = [
            "toolName": toolName,
            "pattern": pattern,
            "scope": scope,
            "decision": decision,
        ]
        if let allowHighRisk { body["allowHighRisk"] = allowHighRisk }
        if let executionTarget { body["executionTarget"] = executionTarget }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/trust-rules/manage", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("addTrustRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.httpError(statusCode: response.statusCode)
        }
    }

    public func removeTrustRule(id: String) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/trust-rules/manage/\(encoded)", timeout: 10
        )
        guard response.isSuccess else {
            log.error("removeTrustRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.httpError(statusCode: response.statusCode)
        }
    }

    public func updateTrustRule(
        id: String,
        tool: String? = nil,
        pattern: String? = nil,
        scope: String? = nil,
        decision: String? = nil,
        priority: Int? = nil
    ) async throws {
        var body: [String: Any] = [:]
        if let tool { body["tool"] = tool }
        if let pattern { body["pattern"] = pattern }
        if let scope { body["scope"] = scope }
        if let decision { body["decision"] = decision }
        if let priority { body["priority"] = priority }

        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.patch(
            path: "assistants/{assistantId}/trust-rules/manage/\(encoded)", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("updateTrustRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.httpError(statusCode: response.statusCode)
        }
    }
}
