import Foundation

private let flagPrefix = "VELLUM_FLAG_"

public enum FeatureFlag: String {
    case demo
}

public final class FeatureFlagManager: @unchecked Sendable {
    public static let shared = FeatureFlagManager()

    private let lock = NSLock()
    private var flags: [String: Bool]

    init(environment: [String: String]? = nil) {
        let env = environment ?? ProcessInfo.processInfo.environment
        var loaded: [String: Bool] = [:]
        for (key, value) in env where key.hasPrefix(flagPrefix) {
            let name = String(key.dropFirst(flagPrefix.count)).lowercased()
            guard !name.isEmpty else { continue }
            loaded[name] = Self.parseBool(value)
        }
        self.flags = loaded
    }

    public func isEnabled(_ flag: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return flags[flag.lowercased()] ?? false
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
        flags[flag.lowercased()] = enabled
    }

    public func setOverride(_ flag: FeatureFlag, enabled: Bool) {
        setOverride(flag.rawValue, enabled: enabled)
    }

    public func removeOverride(_ flag: String) {
        lock.lock()
        defer { lock.unlock() }
        flags.removeValue(forKey: flag.lowercased())
    }

    public func removeOverride(_ flag: FeatureFlag) {
        removeOverride(flag.rawValue)
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
