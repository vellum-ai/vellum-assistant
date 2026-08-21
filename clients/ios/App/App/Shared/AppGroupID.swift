import Foundation

/// The App Group container this build target shares with its sibling bundles,
/// resolved from its own bundle rather than hardcoded.
///
/// Each environment sets `APP_GROUP_ID` in its xcconfig
/// (`group.ai.vocify-inc.vellum-assistant-ios` plus `.staging` and `.dev`
/// suffixes), so a hardcoded literal would let a Dev or Staging build read
/// and overwrite the production app's shared container, which is the one
/// boundary a per-environment group exists to hold.
///
/// Shared by the app targets and the VoiceActivity widget extension so there
/// is one implementation. Both read the same ``infoPlistKey``: unlike a URL
/// scheme there is no registration to inspect, and the entitlement that
/// actually grants access is not readable from Swift, so the identifier
/// travels as a plain string populated from the very same `$(APP_GROUP_ID)`
/// variable that fills the entitlement.
///
/// ``current`` is deliberately optional, for the same reason
/// ``BundleURLScheme/current`` is: there is no safe universal fallback.
/// Substituting the production group on a misconfigured build would cross
/// exactly the boundary above. Callers degrade to doing nothing, never to
/// another environment's container.
enum AppGroupID {
    /// Info.plist key carrying the App Group identifier.
    static let infoPlistKey = "VellumAppGroupId"

    /// The group for the currently running bundle, or `nil` when the bundle
    /// declares none. See the type docs for why there is no default.
    static let current: String? = resolve(in: .main)

    static func resolve(in bundle: Bundle) -> String? {
        (bundle.infoDictionary?[infoPlistKey] as? String).flatMap(substituted)
    }

    /// Rejects an empty value and one Xcode never expanded (`$(APP_GROUP_ID)`),
    /// both of which would otherwise name a container that cannot be opened.
    private static func substituted(_ raw: String) -> String? {
        guard !raw.isEmpty, !raw.contains("$") else { return nil }
        return raw
    }
}
