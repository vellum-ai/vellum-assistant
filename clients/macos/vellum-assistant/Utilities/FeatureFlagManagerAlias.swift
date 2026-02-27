import VellumAssistantShared

/// Convenience alias so onboarding code can use `FeatureFlagManager` instead of the
/// full `MacOSClientFeatureFlagManager` name. Also provides dot-syntax for known flag keys.
typealias FeatureFlagManager = MacOSClientFeatureFlagManager

extension MacOSClientFeatureFlagManager {
    /// Dot-syntax accessors for known feature flag keys.
    enum FlagKey: String {
        case userHostedEnabled = "user_hosted_enabled"
    }

    func isEnabled(_ key: FlagKey) -> Bool {
        isEnabled(key.rawValue)
    }

    func setOverride(_ key: FlagKey, enabled: Bool) {
        setOverride(key.rawValue, enabled: enabled)
    }
}
