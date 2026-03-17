import Foundation
import os

private let flagPrefix = "VELLUM_FLAG_"
private let userDefaultsPrefix = "MacOSFeatureFlag."
private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "FeatureFlags")

/// Represents the resolved state of a single macOS feature flag for UI display.
public struct MacOSFeatureFlagState: Identifiable {
    public let id: String
    public let key: String
    public let label: String
    public let description: String
    public let defaultEnabled: Bool
    public var enabled: Bool
}

public final class MacOSClientFeatureFlagManager: @unchecked Sendable {
    public static let shared = MacOSClientFeatureFlagManager()

    private let lock = NSLock()
    /// Overrides from env vars, .env file, and UserDefaults. Keyed by normalized flag name.
    private var overrides: [String: Bool]
    /// Flag definitions loaded from the unified registry.
    private var flagDefinitions: [FeatureFlagDefinition]

    init(environment: [String: String]? = nil) {
        let env = environment ?? ProcessInfo.processInfo.environment
        let isExplicitEnvironment = environment != nil
        var loaded: [String: Bool] = [:]

        // Load UserDefaults overrides only for production (non-explicit env).
        // When an explicit environment is provided (e.g. tests/previews),
        // skip UserDefaults to maintain isolation and determinism.
        if !isExplicitEnvironment {
            let defaults = UserDefaults.standard
            for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(userDefaultsPrefix) {
                let name = String(key.dropFirst(userDefaultsPrefix.count))
                guard !name.isEmpty else { continue }
                loaded[name] = defaults.bool(forKey: key)
            }
        }

        // Env var overrides take priority over UserDefaults
        for (key, value) in env where key.hasPrefix(flagPrefix) {
            let name = String(key.dropFirst(flagPrefix.count)).lowercased().replacingOccurrences(of: "_", with: "")
            guard !name.isEmpty else { continue }
            loaded[name] = Self.parseBool(value)
        }
        self.overrides = loaded
        self.flagDefinitions = []
        loadRegistry()
    }

    /// Load macOS-scope flag definitions from the bundled registry.
    private func loadRegistry() {
        if let registry = loadFeatureFlagRegistry() {
            flagDefinitions = registry.macosScopeFlags()
        } else {
            log.warning("Failed to load feature flag registry from bundle — falling back to empty definitions")
            flagDefinitions = []
        }
    }

    /// Check whether a flag is enabled by its key (e.g. "user_hosted_enabled").
    /// Resolution order: override (env var / .env file / UserDefaults) -> registry defaultEnabled -> false.
    public func isEnabled(_ key: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let override = overrides[Self.normalize(key)] {
            return override
        }
        // Fall back to registry default
        if let def = flagDefinitions.first(where: { Self.normalize($0.key) == Self.normalize(key) }) {
            return def.defaultEnabled
        }
        return false
    }

    /// Return the resolved state of all macOS-scope flag definitions for UI display.
    public func allFlagStates() -> [MacOSFeatureFlagState] {
        lock.lock()
        defer { lock.unlock() }
        return flagDefinitions.map { def in
            let enabled = overrides[Self.normalize(def.key)] ?? def.defaultEnabled
            return MacOSFeatureFlagState(
                id: def.id,
                key: def.key,
                label: def.label,
                description: def.description,
                defaultEnabled: def.defaultEnabled,
                enabled: enabled
            )
        }
    }

    public func setOverride(_ key: String, enabled: Bool) {
        lock.lock()
        defer { lock.unlock() }
        let normalized = Self.normalize(key)
        overrides[normalized] = enabled
        UserDefaults.standard.set(enabled, forKey: userDefaultsPrefix + normalized)
    }

    public func removeOverride(_ key: String) {
        lock.lock()
        defer { lock.unlock() }
        let normalized = Self.normalize(key)
        overrides.removeValue(forKey: normalized)
        UserDefaults.standard.removeObject(forKey: userDefaultsPrefix + normalized)
    }

    /// Load VELLUM_FLAG_* entries from a `.env` file and apply them as overrides.
    public func loadFromFile(at path: String) {
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        lock.lock()
        defer { lock.unlock() }
        for line in contents.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
            let parts = trimmed.split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let key = String(parts[0]).trimmingCharacters(in: .whitespaces)
            guard key.hasPrefix(flagPrefix) else { continue }
            let name = String(key.dropFirst(flagPrefix.count)).lowercased().replacingOccurrences(of: "_", with: "")
            guard !name.isEmpty else { continue }
            let value = String(parts[1]).trimmingCharacters(in: .whitespaces)
            overrides[name] = Self.parseBool(value)
        }
    }

    /// Walk up from the app executable to find the repo root `.env` file.
    public static func findRepoEnvFile() -> String? {
        guard let execURL = Bundle.main.executableURL else { return nil }
        var dir = execURL.deletingLastPathComponent()
        for _ in 0..<10 {
            let candidate = dir.appendingPathComponent(".env")
            let gitDir = dir.appendingPathComponent(".git")
            if FileManager.default.fileExists(atPath: gitDir.path),
               FileManager.default.fileExists(atPath: candidate.path) {
                return candidate.path
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    private static func normalize(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
    }

    private static func parseBool(_ value: String) -> Bool {
        switch value.lowercased().trimmingCharacters(in: .whitespaces) {
        case "1", "true", "yes", "on":
            return true
        default:
            return false
        }
    }
}
