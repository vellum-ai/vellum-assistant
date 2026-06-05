import Foundation

// MARK: - Types

/// Scope of a feature flag — determines which platform consumes it.
/// `both` is read by both the assistant backend and clients.
public enum FeatureFlagScope: String, Decodable {
    case assistant
    case client
    case both
}

/// The `defaultEnabled` value in the registry is either a `Bool` (for boolean
/// flags) or a `String` (for string/experiment flags).
public enum FlagDefault: Decodable, Equatable {
    case bool(Bool)
    case string(String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public var boolValue: Bool? {
        if case .bool(let v) = self { return v }
        return nil
    }

    public var isBoolean: Bool { boolValue != nil }
}

/// A single entry in the unified feature flag registry.
public struct FeatureFlagDefinition: Decodable {
    public let id: String
    public let scope: FeatureFlagScope
    public let key: String
    public let label: String
    public let description: String
    public let defaultEnabled: FlagDefault
}

/// Top-level schema for `feature-flag-registry.json`.
public struct FeatureFlagRegistry: Decodable {
    public let version: Int
    public let flags: [FeatureFlagDefinition]

    // MARK: - Scope filters

    /// Return flags consumed by clients (`scope == .client` or `.both`).
    public func clientScopeFlags() -> [FeatureFlagDefinition] {
        flags.filter { $0.scope == .client || $0.scope == .both }
    }

    /// Boolean-only client flags — excludes string/experiment flags that the
    /// macOS toggle UI cannot represent.
    public func clientBooleanFlags() -> [FeatureFlagDefinition] {
        clientScopeFlags().filter { $0.defaultEnabled.isBoolean }
    }

    /// Return flags consumed by the assistant backend (`scope == .assistant` or `.both`).
    public func assistantScopeFlags() -> [FeatureFlagDefinition] {
        flags.filter { $0.scope == .assistant || $0.scope == .both }
    }
}

// MARK: - Loader

/// Cached registry loaded once per process lifetime.
/// The bundled `feature-flag-registry.json` is immutable at runtime (baked into
/// the app at build time), so reading it more than once is unnecessary I/O.
/// Swift guarantees thread-safe lazy initialization of static properties.
private let _cachedFeatureFlagRegistry: FeatureFlagRegistry? = {
    guard let url = Bundle.main.url(forResource: "feature-flag-registry", withExtension: "json") else {
        return nil
    }
    guard let data = try? Data(contentsOf: url) else {
        return nil
    }
    return try? JSONDecoder().decode(FeatureFlagRegistry.self, from: data)
}()

/// Load the unified feature flag registry from the app bundle's Resources.
///
/// Returns a cached result after the first call — the bundled JSON never
/// changes at runtime so re-reading from disk is unnecessary.
public func loadFeatureFlagRegistry() -> FeatureFlagRegistry? {
    _cachedFeatureFlagRegistry
}
