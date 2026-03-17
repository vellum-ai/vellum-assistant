import Foundation
import VellumAssistantShared

/// Resolves assistant-scoped feature flags from workspace config plus the
/// bundled unified registry, mirroring the daemon's precedence order.
enum AssistantFeatureFlagResolver {
    static func registryDefaults(from registry: FeatureFlagRegistry?) -> [String: Bool] {
        Dictionary(
            uniqueKeysWithValues: (registry?.assistantScopeFlags() ?? []).map {
                ($0.key, $0.defaultEnabled)
            }
        )
    }

    static func resolvedFlags(
        config: [String: Any],
        registryDefaults: [String: Bool]
    ) -> [String: Bool] {
        let persistedFlags = (config["assistantFeatureFlagValues"] as? [String: Bool]) ?? [:]
        return registryDefaults.merging(persistedFlags) { _, persisted in persisted }
    }

    static func resolvedFlags(
        config: [String: Any],
        registry: FeatureFlagRegistry?
    ) -> [String: Bool] {
        resolvedFlags(config: config, registryDefaults: registryDefaults(from: registry))
    }

    static func isEnabled(
        _ key: String,
        config: [String: Any]? = nil,
        registry: FeatureFlagRegistry? = nil
    ) -> Bool {
        let resolved = resolvedFlags(
            config: config ?? WorkspaceConfigIO.read(),
            registry: registry ?? loadFeatureFlagRegistry()
        )
        return resolved[key] ?? true
    }
}
