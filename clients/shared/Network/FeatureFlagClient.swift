import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "FeatureFlagClient")

/// Focused client for feature-flag and privacy-config operations routed through the gateway.
@MainActor
public protocol FeatureFlagClientProtocol {
    func getFeatureFlags() async throws -> [AssistantFeatureFlag]
    func setFeatureFlag(key: String, enabled: Bool) async throws
    func setPrivacyConfig(collectUsageData: Bool?, sendDiagnostics: Bool?) async throws
}

// MARK: - Response Types

/// A feature flag sourced from the gateway API, used by the settings UI.
public struct AssistantFeatureFlag: Decodable, Identifiable, Sendable {
    public let key: String
    public let enabled: Bool
    public let defaultEnabled: Bool?
    public let description: String?
    public let label: String?

    public var id: String { key }

    public init(key: String, enabled: Bool, defaultEnabled: Bool? = true, description: String? = nil, label: String? = nil) {
        self.key = key
        self.enabled = enabled
        self.defaultEnabled = defaultEnabled
        self.description = description
        self.label = label
    }

    /// Derive a human-readable name from the flag key.
    /// e.g. "feature_flags.browser.enabled" -> "Browser"
    public var displayName: String {
        if let label = label { return label }
        var name = key
        if name.hasPrefix("feature_flags.") {
            name = String(name.dropFirst("feature_flags.".count))
        }
        if name.hasSuffix(".enabled") {
            name = String(name.dropLast(".enabled".count))
        }
        return name
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: ".", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }
}

/// Wrapper for the flags array returned by the feature-flags endpoint.
private struct FeatureFlagsResponse<Flag: Decodable>: Decodable {
    let flags: [Flag]
}

public enum FeatureFlagError: Error, LocalizedError {
    case requestFailed(Int)

    public var errorDescription: String? {
        switch self {
        case .requestFailed(let code):
            return "Feature-flag request failed (HTTP \(code))"
        }
    }
}

// MARK: - Gateway-Backed Implementation

/// Gateway-backed implementation of ``FeatureFlagClientProtocol``.
@MainActor
public struct FeatureFlagClient: FeatureFlagClientProtocol {
    nonisolated public init() {}

    public func getFeatureFlags() async throws -> [AssistantFeatureFlag] {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/feature-flags", timeout: 10
        )
        guard response.isSuccess else {
            log.error("getFeatureFlags failed (HTTP \(response.statusCode))")
            throw FeatureFlagError.requestFailed(response.statusCode)
        }
        let decoded = try JSONDecoder().decode(FeatureFlagsResponse<AssistantFeatureFlag>.self, from: response.data)
        return decoded.flags
    }

    public func setFeatureFlag(key: String, enabled: Bool) async throws {
        let response = try await GatewayHTTPClient.patch(
            path: "assistants/{assistantId}/feature-flags/\(key)",
            json: ["enabled": enabled],
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("setFeatureFlag failed (HTTP \(response.statusCode))")
            throw FeatureFlagError.requestFailed(response.statusCode)
        }
    }

    public func setPrivacyConfig(collectUsageData: Bool? = nil, sendDiagnostics: Bool? = nil) async throws {
        var body: [String: Any] = [:]
        if let collectUsageData { body["collectUsageData"] = collectUsageData }
        if let sendDiagnostics { body["sendDiagnostics"] = sendDiagnostics }

        let response = try await GatewayHTTPClient.patch(
            path: "assistants/{assistantId}/config/privacy",
            json: body,
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("setPrivacyConfig failed (HTTP \(response.statusCode))")
            throw FeatureFlagError.requestFailed(response.statusCode)
        }
    }
}
