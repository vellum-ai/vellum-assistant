import Foundation

private let flagPrefix = "VELLUM_FLAG_"

public enum FeatureFlag: String, CaseIterable {
    case demo
    case userHostedEnabled = "user_hosted_enabled"
    case featureFlagEditorEnabled = "feature_flag_editor_enabled"
    case hatchNewAssistantEnabled = "hatch_new_assistant_enabled"
    case localHttpEnabled = "local_http_enabled"

    public var displayName: String {
        switch self {
        case .demo: return "Demo"
        case .userHostedEnabled: return "User Hosted Enabled"
        case .featureFlagEditorEnabled: return "Feature Flag Editor Enabled"
        case .hatchNewAssistantEnabled: return "Hatch New Assistant Enabled"
        case .localHttpEnabled: return "Local HTTP Enabled"
        }
    }
}

public final class FeatureFlagManager: @unchecked Sendable {
    public static let shared = FeatureFlagManager()

    private let lock = NSLock()
    private var flags: [String: Bool]

    init(environment: [String: String]? = nil) {
        let env = environment ?? ProcessInfo.processInfo.environment
        var loaded: [String: Bool] = [:]
        for (key, value) in env where key.hasPrefix(flagPrefix) {
            let name = String(key.dropFirst(flagPrefix.count)).lowercased().replacingOccurrences(of: "_", with: "")
            guard !name.isEmpty else { continue }
            loaded[name] = Self.parseBool(value)
        }
        self.flags = loaded
    }

    public func isEnabled(_ flag: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return flags[Self.normalize(flag)] ?? false
    }

    public func isEnabled(_ flag: FeatureFlag) -> Bool {
        isEnabled(flag.rawValue)
    }

    public func allFlags() -> [String: Bool] {
        lock.lock()
        defer { lock.unlock() }
        return flags
    }

    public func setOverride(_ flag: String, enabled: Bool) {
        lock.lock()
        defer { lock.unlock() }
        flags[Self.normalize(flag)] = enabled
    }

    public func setOverride(_ flag: FeatureFlag, enabled: Bool) {
        setOverride(flag.rawValue, enabled: enabled)
    }

    public func removeOverride(_ flag: String) {
        lock.lock()
        defer { lock.unlock() }
        flags.removeValue(forKey: Self.normalize(flag))
    }

    public func removeOverride(_ flag: FeatureFlag) {
        removeOverride(flag.rawValue)
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
            flags[name] = Self.parseBool(value)
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
        name.lowercased().replacingOccurrences(of: "_", with: "")
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
