import Foundation

/// Central resolver for pairing configuration.
/// Reads from UserDefaults and provides resolved values.
/// Placed in the shared target so both iOS and macOS can use it.
public enum PairingConfiguration {
    // MARK: - Keys

    public static let gatewayOverrideKey = "iosPairingGatewayOverride"
    public static let tokenOverrideKey = "iosPairingTokenOverride"

    // MARK: - Resolution

    /// Resolve the gateway URL: use override if non-empty, else fallback.
    public static func resolvedGatewayURL(fallback: String) -> String {
        if let override = nonEmpty(UserDefaults.standard.string(forKey: gatewayOverrideKey)) {
            return override
        }
        return fallback
    }

    /// Resolve the bearer token: use override if non-empty, else fallback.
    public static func resolvedBearerToken(fallback: String) -> String {
        if let override = nonEmpty(UserDefaults.standard.string(forKey: tokenOverrideKey)) {
            return override
        }
        return fallback
    }

    /// Reset all override settings.
    public static func resetOverrides() {
        UserDefaults.standard.set("", forKey: gatewayOverrideKey)
        UserDefaults.standard.set("", forKey: tokenOverrideKey)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let v = value?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
        return v
    }
}
