import Foundation

/// Central resolver for pairing configuration.
/// Reads from UserDefaults and provides resolved values.
/// Placed in the shared target so both iOS and macOS can use it.
public enum PairingConfiguration {
    // MARK: - Keys

    public static let overrideEnabledKey = "iosPairingUseOverride"
    public static let gatewayOverrideKey = "iosPairingGatewayOverride"
    public static let tokenOverrideKey = "iosPairingTokenOverride"
    public static let devLocalPairingKey = "devLocalPairingEnabled"

    // MARK: - Override State

    public static var isOverrideEnabled: Bool {
        UserDefaults.standard.bool(forKey: overrideEnabledKey)
    }

    public static var devLocalPairingEnabled: Bool {
        UserDefaults.standard.bool(forKey: devLocalPairingKey)
    }

    // MARK: - Resolution

    /// Resolve the gateway URL: override if enabled, else fallback.
    public static func resolvedGatewayURL(fallback: String) -> String {
        if isOverrideEnabled {
            if let override = nonEmpty(UserDefaults.standard.string(forKey: gatewayOverrideKey)) {
                return override
            }
        }
        return fallback
    }

    /// Resolve the bearer token: override if enabled, else fallback.
    public static func resolvedBearerToken(fallback: String) -> String {
        if isOverrideEnabled {
            if let override = nonEmpty(UserDefaults.standard.string(forKey: tokenOverrideKey)) {
                return override
            }
        }
        return fallback
    }

    /// Reset all override settings.
    public static func resetOverrides() {
        UserDefaults.standard.set(false, forKey: overrideEnabledKey)
        UserDefaults.standard.set("", forKey: gatewayOverrideKey)
        UserDefaults.standard.set("", forKey: tokenOverrideKey)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let v = value?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
        return v
    }
}
