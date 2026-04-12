import Foundation

extension Bundle {
    /// The app's bundle identifier, guaranteed non-nil.
    ///
    /// Falls back to the production identifier for contexts where
    /// `Bundle.main.bundleIdentifier` is unavailable (e.g. SPM test builds).
    /// At runtime the value is environment-specific (e.g.
    /// `com.vellum.vellum-assistant-dev`, `com.vellum.vellum-assistant-staging`)
    /// because `build.sh` stamps the bundle ID per `VELLUM_ENVIRONMENT`.
    public static let appBundleIdentifier: String = main.bundleIdentifier ?? "com.vellum.vellum-assistant"
}
