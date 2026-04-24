import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "TrustRuleV3Client")

// MARK: - Types

/// A trust rule from the v3 trust rules API.
public struct TrustRuleV3: Codable, Identifiable, Sendable {
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

private struct TrustRuleV3ListResponse: Decodable {
    let rules: [TrustRuleV3]
}

private struct TrustRuleV3SingleResponse: Decodable {
    let rule: TrustRuleV3
}

// MARK: - Errors

public enum TrustRuleV3ClientError: Error, LocalizedError {
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

public protocol TrustRuleV3ClientProtocol {
    func listRules(origin: String?, tool: String?, includeDeleted: Bool?) async throws -> [TrustRuleV3]
    func createRule(tool: String, pattern: String, risk: String, description: String) async throws -> TrustRuleV3
    func updateRule(id: String, risk: String?, description: String?) async throws -> TrustRuleV3
    func deleteRule(id: String) async throws
    func resetRule(id: String) async throws -> TrustRuleV3
}

// MARK: - Gateway-Backed Implementation

/// Gateway-backed implementation of ``TrustRuleV3ClientProtocol``.
public struct TrustRuleV3Client: TrustRuleV3ClientProtocol {
    nonisolated public init() {}

    public func listRules(origin: String? = nil, tool: String? = nil, includeDeleted: Bool? = nil) async throws -> [TrustRuleV3] {
        var params: [String: String] = [:]
        if let origin { params["origin"] = origin }
        if let tool { params["tool"] = tool }
        if let includeDeleted { params["include_deleted"] = String(includeDeleted) }

        let response = try await GatewayHTTPClient.get(
            path: "trust-rules-v3", params: params, timeout: 10
        )
        guard response.isSuccess else {
            log.error("listRules failed (HTTP \(response.statusCode))")
            throw TrustRuleV3ClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleV3ListResponse.self, from: response.data).rules
    }

    public func createRule(tool: String, pattern: String, risk: String, description: String) async throws -> TrustRuleV3 {
        let body: [String: Any] = [
            "tool": tool,
            "pattern": pattern,
            "risk": risk,
            "description": description,
        ]
        let response = try await GatewayHTTPClient.post(
            path: "trust-rules-v3", json: body, timeout: 10
        )
        if response.statusCode == 403 {
            throw TrustRuleV3ClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("createRule failed (HTTP \(response.statusCode))")
            throw TrustRuleV3ClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleV3SingleResponse.self, from: response.data).rule
    }

    public func updateRule(id: String, risk: String? = nil, description: String? = nil) async throws -> TrustRuleV3 {
        var body: [String: Any] = [:]
        if let risk { body["risk"] = risk }
        if let description { body["description"] = description }

        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.patch(
            path: "trust-rules-v3/\(encoded)", json: body, timeout: 10
        )
        if response.statusCode == 404 {
            throw TrustRuleV3ClientError.notFound
        }
        if response.statusCode == 403 {
            throw TrustRuleV3ClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("updateRule failed (HTTP \(response.statusCode))")
            throw TrustRuleV3ClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleV3SingleResponse.self, from: response.data).rule
    }

    public func deleteRule(id: String) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.delete(
            path: "trust-rules-v3/\(encoded)", timeout: 10
        )
        if response.statusCode == 404 {
            throw TrustRuleV3ClientError.notFound
        }
        if response.statusCode == 403 {
            throw TrustRuleV3ClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("deleteRule failed (HTTP \(response.statusCode))")
            throw TrustRuleV3ClientError.requestFailed(response.statusCode)
        }
    }

    public func resetRule(id: String) async throws -> TrustRuleV3 {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response = try await GatewayHTTPClient.post(
            path: "trust-rules-v3/\(encoded)/reset", json: [:], timeout: 10
        )
        if response.statusCode == 404 {
            throw TrustRuleV3ClientError.notFound
        }
        if response.statusCode == 403 {
            throw TrustRuleV3ClientError.featureDisabled
        }
        guard response.isSuccess else {
            log.error("resetRule failed (HTTP \(response.statusCode))")
            throw TrustRuleV3ClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(TrustRuleV3SingleResponse.self, from: response.data).rule
    }
}
