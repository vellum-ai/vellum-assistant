import Foundation

/// The custom URL scheme this build registers, read from the bundle rather than
/// hardcoded.
///
/// The three targets ship three schemes — `vellum-assistant`,
/// `vellum-assistant-staging`, `vellum-assistant-dev` — each injected as
/// `$(BUNDLE_URL_SCHEME)` from `App/Config/*.xcconfig` into `Info.plist`'s
/// `CFBundleURLSchemes`. Hardcoding the production scheme would make a Dev or
/// Staging build hand its deep links to the production app whenever both are
/// installed.
enum BundleURLScheme {
    /// `nil` when the plist entry is missing, empty, or left un-substituted
    /// (a literal `$(BUNDLE_URL_SCHEME)`, which happens when a target is built
    /// without its xcconfig). Callers decide whether to fall back or bail.
    static let current: String? = {
        guard let urlTypes = Bundle.main.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]],
              let schemes = urlTypes.first?["CFBundleURLSchemes"] as? [String],
              let scheme = schemes.first,
              !scheme.isEmpty,
              !scheme.contains("$")
        else {
            return nil
        }
        return scheme
    }()
}
