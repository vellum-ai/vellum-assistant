import Foundation
import VellumAssistantShared

/// Resolves assistant-scoped feature flags from the gateway API (cached in
/// UserDefaults) plus the bundled unified registry.
///
/// **Priority order:** persisted overrides > gateway cache > registry defaults.
///
/// *Persisted overrides* are user-toggled flags from Developer Settings, stored
/// in UserDefaults so they survive app restarts and work in Docker/platform
/// mode (no disk access required). Overrides are also PATCH-ed to the gateway
/// as a best-effort write so the daemon stays in sync.
///
/// *Gateway cache* is the last successful fetch from
/// `GET assistants/{id}/feature-flags`, stored in UserDefaults.
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

    /// Removes all cached feature flags and persisted overrides from UserDefaults.
    ///
    /// Call this when the connected assistant changes so that stale values
    /// from the previous assistant do not leak into the new one.
    static func clearCachedFlags() {
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(cachePrefix) || key.hasPrefix(overridePrefix) {
            defaults.removeObject(forKey: key)
        }
    }

    // MARK: - Persisted overrides (UserDefaults)

    private static let overridePrefix = "AssistantFeatureFlagOverride."

    /// Reads all persisted feature-flag overrides from UserDefaults.
    ///
    /// These are user-toggled flags from Developer Settings that take
    /// precedence over both the gateway cache and registry defaults.
    static func readPersistedOverrides() -> [String: Bool] {
        let defaults = UserDefaults.standard
        var result: [String: Bool] = [:]
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(overridePrefix) {
            let name = String(key.dropFirst(overridePrefix.count))
            guard !name.isEmpty else { continue }
            result[name] = defaults.bool(forKey: key)
        }
        return result
    }

    /// Writes a single persisted override to UserDefaults.
    static func writePersistedOverride(key: String, enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "\(overridePrefix)\(key)")
    }

    /// Removes all persisted overrides from UserDefaults.
    static func clearPersistedOverrides() {
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(overridePrefix) {
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
        persistedOverrides: [String: Bool],
        registryDefaults: [String: Bool]
    ) -> [String: Bool] {
        registryDefaults.merging(persistedOverrides) { _, override in override }
    }

    static func resolvedFlags(
        registryDefaults: [String: Bool]
    ) -> [String: Bool] {
        let overrides = readPersistedOverrides()
        let cached = readCachedFlags()
        // Priority: persisted overrides > cached gateway flags > defaults
        return registryDefaults
            .merging(cached) { _, new in new }
            .merging(overrides) { _, new in new }
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
