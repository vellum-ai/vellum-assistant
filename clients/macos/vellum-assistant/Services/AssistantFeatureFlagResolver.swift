import Foundation
import VellumAssistantShared

/// Resolves assistant-scoped feature flags from the protected feature-flags
/// file plus the bundled unified registry, mirroring the daemon's precedence
/// order.
///
/// Persisted overrides are read from `~/.vellum/protected/feature-flags.json`
/// (instance-aware via the connected assistant's lockfile entry). The file
/// format is: `{ "version": 1, "values": { "flagKey": true/false } }`.
enum AssistantFeatureFlagResolver {

    // MARK: - Protected feature-flags file path

    /// Resolves the path to the protected feature-flags file for the currently
    /// connected assistant. Falls back to `~/.vellum/protected/feature-flags.json`
    /// when no instance directory is available.
    static func resolvedFeatureFlagsPath() -> String {
        if let instanceDir = LockfileAssistant.connectedInstanceDir() {
            return URL(fileURLWithPath: instanceDir)
                .appendingPathComponent(".vellum/protected/feature-flags.json")
                .path
        }
        return defaultFeatureFlagsPath
    }

    /// Default path: `~/.vellum/protected/feature-flags.json`.
    static let defaultFeatureFlagsPath: String = {
        let home = NSHomeDirectory()
        return "\(home)/.vellum/protected/feature-flags.json"
    }()

    // MARK: - Protected file I/O

    /// Reads persisted feature-flag overrides from the protected file.
    ///
    /// Returns an empty dictionary when the file is missing, empty, contains
    /// malformed JSON, or lacks a `values` object.
    static func readPersistedFlags(from path: String? = nil) -> [String: Bool] {
        let filePath = path ?? resolvedFeatureFlagsPath()

        guard FileManager.default.fileExists(atPath: filePath),
              let data = FileManager.default.contents(atPath: filePath),
              !data.isEmpty else {
            return [:]
        }

        guard let json = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = json as? [String: Any],
              dict["version"] as? Int == 1,
              let values = dict["values"] as? [String: Bool] else {
            return [:]
        }

        return values
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
        let persistedFlags = readPersistedFlags()
        return resolvedFlags(persistedFlags: persistedFlags, registryDefaults: registryDefaults)
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
