import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "FeatureFlagClient")

/// Focused client for feature-flag and privacy-config operations routed through the gateway.
public protocol FeatureFlagClientProtocol {
    func getFeatureFlags() async throws -> [AssistantFeatureFlag]
    func setFeatureFlag(key: String, enabled: Bool) async throws
    func getPrivacyConfig() async throws -> PrivacyConfig
    func setPrivacyConfig(
        collectUsageData: Bool?,
        sendDiagnostics: Bool?,
        llmRequestLogRetentionMs: Int64?
    ) async throws
}

// MARK: - Response Types

/// Privacy configuration sourced from the gateway API.
///
/// Mirrors the `{assistantId}/config/privacy` response shape and carries the
/// three user-facing privacy toggles: usage data, diagnostics, and LLM request
/// log retention (in milliseconds).
public struct PrivacyConfig: Decodable, Sendable, Equatable {
    public let collectUsageData: Bool
    public let sendDiagnostics: Bool
    public let llmRequestLogRetentionMs: Int64

    public init(
        collectUsageData: Bool,
        sendDiagnostics: Bool,
        llmRequestLogRetentionMs: Int64
    ) {
        self.collectUsageData = collectUsageData
        self.sendDiagnostics = sendDiagnostics
        self.llmRequestLogRetentionMs = llmRequestLogRetentionMs
    }
}

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
    /// e.g. "settings-developer-nav" -> "Settings Developer Nav"
    public var displayName: String {
        if let label = label { return label }
        return key
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

/// Wrapper for the platform's dict-format response: `{ "flags": { "key": bool } }`.
private struct PlatformFeatureFlagsResponse: Decodable {
    let flags: [String: Bool]
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
        // Try gateway array format first: { "flags": [{ key, enabled, ... }] }
        if let decoded = try? JSONDecoder().decode(FeatureFlagsResponse<AssistantFeatureFlag>.self, from: response.data) {
            return decoded.flags
        }
        // Fall back to platform dict format: { "flags": { "key": bool } }
        let platform = try JSONDecoder().decode(PlatformFeatureFlagsResponse.self, from: response.data)
        // Build a lookup from registry keys to their definitions so we can
        // enrich each flag with defaultEnabled, description, and label.
        let registryByKey: [String: FeatureFlagDefinition] = {
            guard let registry = loadFeatureFlagRegistry() else { return [:] }
            return Dictionary(registry.assistantScopeFlags().map { ($0.key, $0) }, uniquingKeysWith: { _, latest in latest })
        }()
        return platform.flags.map { key, enabled in
            // Platform keys use LaunchDarkly format like "feature_flags.browser.enabled".
            // Extract the middle segment(s) to match the registry's kebab-case key.
            let registryKey: String = {
                let stripped = key.hasPrefix("feature_flags.") ? String(key.dropFirst("feature_flags.".count)) : key
                return stripped.hasSuffix(".enabled") ? String(stripped.dropLast(".enabled".count)) : stripped
            }()
            let def = registryByKey[registryKey]
            return AssistantFeatureFlag(
                key: registryKey,
                enabled: enabled,
                defaultEnabled: def?.defaultEnabled,
                description: def?.description,
                label: def?.label
            )
        }
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

    public func getPrivacyConfig() async throws -> PrivacyConfig {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/config/privacy",
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("getPrivacyConfig failed (HTTP \(response.statusCode))")
            throw FeatureFlagError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(PrivacyConfig.self, from: response.data)
    }

    public func setPrivacyConfig(
        collectUsageData: Bool? = nil,
        sendDiagnostics: Bool? = nil,
        llmRequestLogRetentionMs: Int64? = nil
    ) async throws {
        var body: [String: Any] = [:]
        if let collectUsageData { body["collectUsageData"] = collectUsageData }
        if let sendDiagnostics { body["sendDiagnostics"] = sendDiagnostics }
        if let llmRequestLogRetentionMs {
            body["llmRequestLogRetentionMs"] = llmRequestLogRetentionMs
        }

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
