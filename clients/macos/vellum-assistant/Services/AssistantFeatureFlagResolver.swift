import Foundation
import VellumAssistantShared

/// Resolves assistant-scoped feature flags from workspace config plus the
/// bundled unified registry, mirroring the daemon's precedence order.
enum AssistantFeatureFlagResolver {
    static func isEnabled(
        _ key: String,
        config: [String: Any]? = nil,
        registry: FeatureFlagRegistry? = nil
    ) -> Bool {
        let registryDefaults = Dictionary(
            uniqueKeysWithValues: ((registry ?? loadFeatureFlagRegistry())?.assistantScopeFlags() ?? []).map {
                ($0.key, $0.defaultEnabled)
            }
        )

        let config = config ?? WorkspaceConfigIO.read()
        let persistedFlags = (config["assistantFeatureFlagValues"] as? [String: Bool]) ?? [:]

        if let explicit = persistedFlags[key] {
            return explicit
        }

        if let defaultEnabled = registryDefaults[key] {
            return defaultEnabled
        }

        return true
    }
}
