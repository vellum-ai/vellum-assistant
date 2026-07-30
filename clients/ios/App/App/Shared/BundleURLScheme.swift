import Foundation

/// The custom URL scheme this build target speaks, resolved from its own
/// bundle rather than hardcoded.
///
/// Each environment sets `BUNDLE_URL_SCHEME` in its xcconfig
/// (`vellum-assistant`, `vellum-assistant-staging`, `vellum-assistant-dev`), so
/// a hardcoded literal would make a Dev or Staging build hand out production
/// links — and if the production app happens to be installed, iOS would open
/// *that* app instead.
///
/// Shared by the app target and the VoiceActivity widget extension so there is
/// one implementation. The two read different keys because they play different
/// roles:
///
/// - The **app** *registers* the scheme in `CFBundleURLTypes`, which is what
///   iOS actually routes on. That registration is authoritative, so it is read
///   first.
/// - An **appex registers nothing** — a widget extension must not claim a URL
///   type — so it carries the scheme as the plain ``infoPlistKey`` string,
///   populated from the very same `$(BUNDLE_URL_SCHEME)` variable. It only
///   needs to *build* a link, never to receive one.
///
/// ``current`` is deliberately optional: there is no safe universal fallback.
/// Substituting the production scheme on a misconfigured Dev or Staging build
/// is precisely the cross-environment mis-routing this type exists to prevent,
/// so each caller must decide explicitly.
///
/// - **Auth** (`NativeAuthPlugin`) falls back to the production scheme: the
///   OAuth callback is not a cross-app launch, and a sign-in that reaches a
///   working callback beats one that fails outright.
/// - **Voice deep links** (``VoiceModeDeepLink``, shared by the App Intents
///   and the Live Activity's `widgetURL`) do *not* fall back. Emitting no link
///   is strictly better than launching voice mode in the wrong app.
enum BundleURLScheme {
    /// Info.plist key carrying the scheme where `CFBundleURLTypes` is absent.
    static let infoPlistKey = "VellumURLScheme"

    /// The scheme for the currently running bundle, or `nil` when the bundle
    /// declares none. See the type docs for why there is no default.
    static let current: String? = resolve(in: .main)

    static func resolve(in bundle: Bundle) -> String? {
        let info = bundle.infoDictionary
        if let urlTypes = info?["CFBundleURLTypes"] as? [[String: Any]],
           let schemes = urlTypes.first?["CFBundleURLSchemes"] as? [String],
           let scheme = schemes.first.flatMap(substituted) {
            return scheme
        }
        return (info?[infoPlistKey] as? String).flatMap(substituted)
    }

    /// Rejects an empty value and one Xcode never expanded (`$(BUNDLE_URL_SCHEME)`),
    /// both of which would otherwise produce an unopenable URL.
    private static func substituted(_ raw: String) -> String? {
        guard !raw.isEmpty, !raw.contains("$") else { return nil }
        return raw
    }
}
