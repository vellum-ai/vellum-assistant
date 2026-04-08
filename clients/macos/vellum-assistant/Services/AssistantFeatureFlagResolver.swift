import Foundation
import VellumAssistantShared

/// Resolves assistant-scoped feature flags from the gateway API (cached in
/// UserDefaults) plus the bundled unified registry.
///
/// **Priority order:** cached gateway flags > registry defaults.
///
/// *Gateway cache* is the last successful fetch from
/// `GET assistants/{id}/feature-flags`, stored in UserDefaults so the next
/// cold-start picks up values before the gateway connection is established.
///
/// Writes (user toggles in Developer Settings) are persisted to the gateway
/// via ``FeatureFlagClient/setFeatureFlag(key:enabled:)`` and simultaneously
/// written to the local cache for optimistic UI.
enum AssistantFeatureFlagResolver {

    // MARK: - UserDefaults cache (gateway fetch results)

    private static let cachePrefix = "AssistantFeatureFlagCache."

    /// Reads all cached feature flags from UserDefaults, stripping the cache prefix.
    static func readCachedFlags() -> [String: Bool] {
        let defaults = UserDefaults.standard
        var result: [String: Bool] = [:]
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(cachePrefix) {
            let name = String(key.dropFirst(cachePrefix.count))
            guard !name.isEmpty else { continue }
            result[name] = defaults.bool(forKey: key)
        }
        return result
    }

    /// Replaces all cached feature flags in UserDefaults with the given dictionary.
    static func writeCachedFlags(_ flags: [String: Bool]) {
        let defaults = UserDefaults.standard
        // Remove all existing cached keys
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(cachePrefix) {
            defaults.removeObject(forKey: key)
        }
        // Write new values
        for (key, value) in flags {
            defaults.set(value, forKey: "\(cachePrefix)\(key)")
        }
    }

    /// Merges a single flag into the UserDefaults cache.
    static func mergeCachedFlag(key: String, enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "\(cachePrefix)\(key)")
    }

    /// Removes all cached feature flags from UserDefaults.
    ///
    /// Call this when the connected assistant changes so that stale cached
    /// values from the previous assistant do not leak into the new one.
    static func clearCachedFlags() {
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(cachePrefix) {
            defaults.removeObject(forKey: key)
        }
    }

    // MARK: - Resolution

    static func registryDefaults(from registry: FeatureFlagRegistry?) -> [String: Bool] {
        Dictionary(
            uniqueKeysWithValues: (registry?.assistantScopeFlags() ?? []).map {
                ($0.key, $0.defaultEnabled)
            }
        )
    }

    static func resolvedFlags(
        persistedFlags: [String: Bool],
        registryDefaults: [String: Bool]
    ) -> [String: Bool] {
        registryDefaults.merging(persistedFlags) { _, persisted in persisted }
    }

    static func resolvedFlags(
        registryDefaults: [String: Bool]
    ) -> [String: Bool] {
        let cached = readCachedFlags()
        // Priority: cached gateway flags > defaults
        return registryDefaults
            .merging(cached) { _, new in new }
    }

    static func resolvedFlags(
        registry: FeatureFlagRegistry?
    ) -> [String: Bool] {
        resolvedFlags(registryDefaults: registryDefaults(from: registry))
    }

    static func isEnabled(
        _ key: String,
        registry: FeatureFlagRegistry? = nil
    ) -> Bool {
        let resolved = resolvedFlags(
            registry: registry ?? loadFeatureFlagRegistry()
        )
        return resolved[key] ?? true
    }
}
