import Foundation

extension Bundle {
    /// The resource bundle containing vendored Lucide icon assets.
    ///
    /// SPM's auto-generated `Bundle.module` uses `Bundle.main.bundleURL` which resolves
    /// to the `.app` root. macOS codesigning requires resources inside `Contents/Resources/`,
    /// so SPM's accessor fails in `.app` bundles. This helper checks `resourceURL` first
    /// (correct for .app), then falls back to `bundleURL` (correct for `swift run`).
    public static let vellumShared: Bundle = {
        let bundleNames = [
            "vellum-assistant_VellumAssistantShared",
            "VellumAssistantShared_VellumAssistantShared",
        ]

        for bundleName in bundleNames {
            // .app bundle: Contents/Resources/
            if let url = Bundle.main.resourceURL?.appendingPathComponent("\(bundleName).bundle"),
               let bundle = Bundle(url: url) {
                return bundle
            }

            // SPM direct build: alongside the executable
            if let bundle = Bundle(url: Bundle.main.bundleURL.appendingPathComponent("\(bundleName).bundle")) {
                return bundle
            }
        }

        #if !SWIFT_PACKAGE
        // Xcode framework build: look adjacent to the framework binary.
        for bundleName in bundleNames {
            if let url = Bundle(for: BundleToken.self).resourceURL?.appendingPathComponent("\(bundleName).bundle"),
               let bundle = Bundle(url: url) {
                return bundle
            }
        }
        #endif

        #if DEBUG
        if ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" {
            return Bundle.main
        }
        #endif

        // Fallback to main bundle — assets may be embedded directly.
        return Bundle.main
    }()
}

#if !SWIFT_PACKAGE
private final class BundleToken {}
#endif
