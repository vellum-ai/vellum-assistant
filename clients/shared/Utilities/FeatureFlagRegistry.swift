import Foundation

// MARK: - Types

/// Scope of a feature flag — determines which platform consumes it.
public enum FeatureFlagScope: String, Decodable {
    case assistant
    case macos
}

/// A single entry in the unified feature flag registry.
public struct FeatureFlagDefinition: Decodable {
    public let id: String
    public let scope: FeatureFlagScope
    public let key: String
    public let label: String
    public let description: String
    public let defaultEnabled: Bool
}

/// Top-level schema for `feature-flag-registry.json`.
public struct FeatureFlagRegistry: Decodable {
    public let version: Int
    public let flags: [FeatureFlagDefinition]

    // MARK: - Scope filters

    /// Return only flags with `scope == .macos`.
    public func macosScopeFlags() -> [FeatureFlagDefinition] {
        flags.filter { $0.scope == .macos }
    }

    /// Return only flags with `scope == .assistant`.
    public func assistantScopeFlags() -> [FeatureFlagDefinition] {
        flags.filter { $0.scope == .assistant }
    }
}

// MARK: - Loader

/// Load the unified feature flag registry from the app bundle's Resources.
///
/// The `feature-flag-registry.json` file must be included in the target's
/// "Copy Bundle Resources" build phase so it appears in `Bundle.main`.
public func loadFeatureFlagRegistry() -> FeatureFlagRegistry? {
    guard let url = Bundle.main.url(forResource: "feature-flag-registry", withExtension: "json") else {
        return nil
    }
    guard let data = try? Data(contentsOf: url) else {
        return nil
    }
    return try? JSONDecoder().decode(FeatureFlagRegistry.self, from: data)
}
