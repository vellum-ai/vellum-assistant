import Foundation

/// Provides access to the SPM resource bundle in both .app bundles and direct SPM builds.
///
/// SPM's auto-generated `Bundle.module` uses `Bundle.main.bundleURL` which resolves
/// to the `.app` root. macOS codesigning requires resources inside `Contents/Resources/`,
/// so SPM's accessor fails in `.app` bundles. This helper checks `resourceURL` first
/// (correct for .app), then falls back to `bundleURL` (correct for `swift run`).
enum ResourceBundle {
    static let bundle: Bundle = {
        let bundleName = "vellum-assistant_VellumAssistantLib"

        // .app bundle: Contents/Resources/
        if let url = Bundle.main.resourceURL?.appendingPathComponent("\(bundleName).bundle"),
           let bundle = Bundle(url: url) {
            return bundle
        }

        // SPM direct build: alongside the executable
        if let bundle = Bundle(url: Bundle.main.bundleURL.appendingPathComponent("\(bundleName).bundle")) {
            return bundle
        }

        #if DEBUG
        // Xcode Previews — resource bundle isn't at either path.
        // Fall back to Bundle.main so previews render without crashing.
        // Gate on XCODE_RUNNING_FOR_PREVIEWS so regular debug builds still fail fast.
        if ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" {
            return Bundle.main
        }
        #endif
        fatalError("Could not find resource bundle '\(bundleName).bundle'")
    }()
}
