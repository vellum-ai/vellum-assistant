import Foundation

extension Bundle {
    /// The app's bundle identifier, guaranteed non-nil.
    ///
    /// Falls back to the production identifier for contexts where
    /// `Bundle.main.bundleIdentifier` is unavailable (e.g. SPM test builds).
    /// In debug builds, this resolves to `com.vellum.vellum-assistant-dev`
    /// so that `log stream` filtering separates dev and production logs.
    public static let appBundleIdentifier: String = main.bundleIdentifier ?? "com.vellum.vellum-assistant"
}
