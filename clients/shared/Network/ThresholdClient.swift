import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ThresholdClient")

// MARK: - Types

/// The three risk-tolerance levels a user can select.
public enum RiskThreshold: String, CaseIterable, Identifiable, Hashable {
    case none = "none"
    case low = "low"
    case medium = "medium"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .none: return "None"
        case .low: return "Low"
        case .medium: return "Medium"
        }
    }
}

/// Global threshold configuration returned by the gateway API.
public struct GlobalThresholds: Codable, Sendable, Equatable {
    public let interactive: String
    public let background: String
    public let headless: String

    public init(interactive: String, background: String, headless: String) {
        self.interactive = interactive
        self.background = background
        self.headless = headless
    }
}

/// Wrapper for the conversation override response.
private struct ConversationOverrideResponse: Decodable {
    let threshold: String?
}

// MARK: - Errors

public enum ThresholdClientError: Error, LocalizedError {
    case requestFailed(Int)

    public var errorDescription: String? {
        switch self {
        case .requestFailed(let code):
            return "Threshold request failed (HTTP \(code))"
        }
    }
}

// MARK: - Protocol

/// Focused client for auto-approve threshold operations routed through the gateway.
public protocol ThresholdClientProtocol {
    func getGlobalThresholds() async throws -> GlobalThresholds
    func setGlobalThresholds(_ thresholds: GlobalThresholds) async throws
    func getConversationOverride(conversationId: String) async throws -> String?
    func setConversationOverride(conversationId: String, threshold: String) async throws
    func deleteConversationOverride(conversationId: String) async throws
}

// MARK: - Gateway-Backed Implementation

/// Gateway-backed implementation of ``ThresholdClientProtocol``.
public struct ThresholdClient: ThresholdClientProtocol {
    nonisolated public init() {}

    public func getGlobalThresholds() async throws -> GlobalThresholds {
        let response = try await GatewayHTTPClient.get(
            path: "permissions/thresholds", timeout: 10
        )
        guard response.isSuccess else {
            log.error("getGlobalThresholds failed (HTTP \(response.statusCode))")
            throw ThresholdClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(GlobalThresholds.self, from: response.data)
    }

    public func setGlobalThresholds(_ thresholds: GlobalThresholds) async throws {
        let body: [String: Any] = [
            "interactive": thresholds.interactive,
            "background": thresholds.background,
            "headless": thresholds.headless,
        ]
        let response = try await GatewayHTTPClient.put(
            path: "permissions/thresholds", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("setGlobalThresholds failed (HTTP \(response.statusCode))")
            throw ThresholdClientError.requestFailed(response.statusCode)
        }
    }

    public func getConversationOverride(conversationId: String) async throws -> String? {
        let response = try await GatewayHTTPClient.get(
            path: "permissions/thresholds/conversations/\(conversationId)", timeout: 10
        )
        if response.statusCode == 404 {
            return nil
        }
        guard response.isSuccess else {
            log.error("getConversationOverride failed (HTTP \(response.statusCode))")
            throw ThresholdClientError.requestFailed(response.statusCode)
        }
        let decoded = try JSONDecoder().decode(ConversationOverrideResponse.self, from: response.data)
        return decoded.threshold
    }

    public func setConversationOverride(conversationId: String, threshold: String) async throws {
        let body: [String: Any] = ["threshold": threshold]
        let response = try await GatewayHTTPClient.put(
            path: "permissions/thresholds/conversations/\(conversationId)", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("setConversationOverride failed (HTTP \(response.statusCode))")
            throw ThresholdClientError.requestFailed(response.statusCode)
        }
    }

    public func deleteConversationOverride(conversationId: String) async throws {
        let response = try await GatewayHTTPClient.delete(
            path: "permissions/thresholds/conversations/\(conversationId)", timeout: 10
        )
        guard response.isSuccess else {
            log.error("deleteConversationOverride failed (HTTP \(response.statusCode))")
            throw ThresholdClientError.requestFailed(response.statusCode)
        }
    }
}
