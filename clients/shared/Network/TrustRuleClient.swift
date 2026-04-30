import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "TrustRuleClient")

// MARK: - Types

/// A trust rule from the trust rules API.
public struct TrustRule: Codable, Identifiable, Sendable {
    public let id: String
    public let tool: String
    public let pattern: String
    public var risk: String
    public let description: String
    public let origin: String
    public let userModified: Bool
    public let deleted: Bool
    public let createdAt: String
    public let updatedAt: String
}

private struct TrustRuleListResponse: Decodable {
    let rules: [TrustRule]
}

private struct TrustRuleSingleResponse: Decodable {
    let rule: TrustRule
}

/// LLM-generated trust rule suggestion from `POST /v1/trust-rules/suggest`.
public struct TrustRuleSuggestion: Decodable, Sendable {
    public let pattern: String
    public let risk: String
    public let scope: String?
    public let description: String
    public let scopeOptions: [TrustRuleSuggestionScopeOption]
    public let directoryScopeOptions: [TrustRuleSuggestionDirectoryScopeOption]?
}

public struct TrustRuleSuggestionScopeOption: Decodable, Sendable {
    public let pattern: String
    public let label: String
}

public struct TrustRuleSuggestionDirectoryScopeOption: Decodable, Sendable {
    public let scope: String
    public let label: String
}

private struct TrustRuleSuggestionResponse: Decodable {
    let suggestion: TrustRuleSuggestion
}

// MARK: - Errors

public enum TrustRuleClientError: Error, LocalizedError {
    case requestFailed(Int)
    case notFound
    case featureDisabled

    public var errorDescription: String? {
        switch self {
        case .requestFailed(let code): return "Trust rule v3 request failed (HTTP \(code))"
        case .notFound: return "Trust rule not found"
        case .featureDisabled: return "Feature not enabled"
        }
    }
}

// MARK: - Protocol

public protocol TrustRuleClientProtocol {
    func listRules(origin: String?, tool: String?, includeDeleted: Bool?) async throws -> [TrustRule]
    func createRule(tool: String, pattern: String, risk: String, description: String, scope: String) async throws -> TrustRule
    func updateRule(id: String, risk: String?, description: String?) async throws -> TrustRule
    func deleteRule(id: String) async throws
    func resetRule(id: String) async throws -> TrustRule
    func suggestRule(
        tool: String,
        command: String,
        riskAssessment: (risk: String, reasoning: String, reasonDescription: String),
        scopeOptions: [(pattern: String, label: String)],
        directoryScopeOptions: [(scope: String, label: String)],
        intent: String,
        existingRule: (id: String, pattern: String, risk: String)?
    ) async throws -> TrustRuleSuggestion
}

// MARK: - Gateway-Backed Implementation

/// Gateway-backed implementation of ``TrustRuleClientProtocol``.
public struct TrustRuleClient: TrustRuleClientProtocol {
    nonisolated public init() {}

    public func listRules(origin: String? = nil, tool: String? = nil, includeDeleted: Bool? = nil) async throws -> [TrustRule] {
        var params: [String: String] = [:]
        if let origin { params["origin"] = origin }
        if let tool { params["tool"] = tool }
        if let includeDeleted { params["include_deleted"] = String(includeDeleted) }

        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/trust-rules", params: params, timeout: 10
        )
        guard response.isSuccess else {
            log.error("listRules failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleListResponse.self, from: response.data).rules
    }

    public func createRule(tool: String, pattern: String, risk: String, description: String, scope: String = "everywhere") async throws -> TrustRule {
        let body: [String: Any] = [
            "tool": tool,
            "pattern": pattern,
            "risk": risk,
            "description": description,
            "scope": scope,
        ]
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/trust-rules", json: body, timeout: 10
        )
        if response.statusCode == 403 {
            throw TrustRuleClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("createRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleSingleResponse.self, from: response.data).rule
    }

    public func updateRule(id: String, risk: String? = nil, description: String? = nil) async throws -> TrustRule {
        var body: [String: Any] = [:]
        if let risk { body["risk"] = risk }
        if let description { body["description"] = description }

        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.patch(
            path: "assistants/{assistantId}/trust-rules/\(encoded)", json: body, timeout: 10
        )
        if response.statusCode == 404 {
            throw TrustRuleClientError.notFound
        }
        if response.statusCode == 403 {
            throw TrustRuleClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("updateRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleSingleResponse.self, from: response.data).rule
    }

    public func deleteRule(id: String) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/trust-rules/\(encoded)", timeout: 10
        )
        if response.statusCode == 404 {
            throw TrustRuleClientError.notFound
        }
        if response.statusCode == 403 {
            throw TrustRuleClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("deleteRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.requestFailed(response.statusCode)
        }
    }

    public func resetRule(id: String) async throws -> TrustRule {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/trust-rules/\(encoded)/reset", json: [:], timeout: 10
        )
        if response.statusCode == 404 {
            throw TrustRuleClientError.notFound
        }
        if response.statusCode == 403 {
            throw TrustRuleClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("resetRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleSingleResponse.self, from: response.data).rule
    }

    public func suggestRule(
        tool: String,
        command: String,
        riskAssessment: (risk: String, reasoning: String, reasonDescription: String),
        scopeOptions: [(pattern: String, label: String)],
        directoryScopeOptions: [(scope: String, label: String)],
        intent: String = "auto_approve",
        existingRule: (id: String, pattern: String, risk: String)? = nil
    ) async throws -> TrustRuleSuggestion {
        var body: [String: Any] = [
            "tool": tool,
            "command": command,
            "riskAssessment": [
                "risk": riskAssessment.risk,
                "reasoning": riskAssessment.reasoning,
                "reasonDescription": riskAssessment.reasonDescription,
            ],
            "scopeOptions": scopeOptions.map { ["pattern": $0.pattern, "label": $0.label] },
            "directoryScopeOptions": directoryScopeOptions.map { ["scope": $0.scope, "label": $0.label] },
            "currentThreshold": "",
            "intent": intent,
        ]
        if let existingRule {
            body["existingRule"] = [
                "id": existingRule.id,
                "pattern": existingRule.pattern,
                "risk": existingRule.risk,
            ]
        }
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/trust-rules/suggest", json: body, timeout: 30
        )
        if response.statusCode == 403 {
            throw TrustRuleClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("suggestRule failed (HTTP \(response.statusCode))")
            throw TrustRuleClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleSuggestionResponse.self, from: response.data).suggestion
    }
}
