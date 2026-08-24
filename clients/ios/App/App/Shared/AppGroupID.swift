import Foundation

/// The App Group container this build target shares with its sibling bundles,
/// resolved from its own bundle rather than hardcoded.
///
/// Each environment sets `APP_GROUP_ID` in its xcconfig
/// (`group.ai.vocify-inc.vellum-assistant-ios`, `...-ios.staging`,
/// `...-ios.dev`), so a hardcoded literal would point a Dev or Staging build
/// at the production container and let one environment read another's data.
///
/// Shared by the app target and the VoiceActivity widget extension so there is
/// one implementation. Both read the same ``infoPlistKey`` string, populated
/// from the very same `$(APP_GROUP_ID)` variable that reaches their
/// entitlements plists: the entitlement is what actually grants access, but it
/// is not readable from Swift, so the value is restated in Info.plist for code
/// to resolve at runtime.
///
/// ``current`` is deliberately optional, mirroring ``BundleURLScheme``: there
/// is no safe universal fallback. A build that ships no group id cannot open a
/// container, and naming another environment's group would only trade a no-op
/// for cross-environment data mixing. Each caller decides explicitly; the one
/// caller today, ``WidgetSnapshotStore``, degrades to doing nothing.
enum AppGroupID {
    /// Info.plist key carrying the group id, restated from the entitlement.
    static let infoPlistKey = "VellumAppGroupId"

    /// The group for the currently running bundle, or `nil` when the bundle
    /// declares none. See the type docs for why there is no default.
    static let current: String? = resolve(in: .main)

    static func resolve(in bundle: Bundle) -> String? {
        (bundle.infoDictionary?[infoPlistKey] as? String).flatMap(substituted)
    }

    /// Rejects an empty value and one Xcode never expanded (`$(APP_GROUP_ID)`),
    /// both of which would otherwise resolve to a suite nothing can reach.
    private static func substituted(_ raw: String) -> String? {
        guard !raw.isEmpty, !raw.contains("$") else { return nil }
        return raw
    }
}
