import Foundation

extension Bundle {
    /// The resource bundle containing vendored Lucide icon assets.
    /// Resolves correctly under both SPM (`Bundle.module`) and Xcode builds.
    public static let vellumShared: Bundle = {
        #if SWIFT_PACKAGE
        return Bundle.module
        #else
        // Xcode build: look for the bundle adjacent to the framework binary.
        let candidates = [
            Bundle.main.resourceURL,
            Bundle(for: BundleToken.self).resourceURL,
        ]
        let bundleName = "VellumAssistantShared_VellumAssistantShared"
        for candidate in candidates {
            let bundlePath = candidate?.appendingPathComponent(bundleName + ".bundle")
            if let bundlePath, let bundle = Bundle(url: bundlePath) {
                return bundle
            }
        }
        // Fallback to main bundle — assets may be embedded directly.
        return Bundle.main
        #endif
    }()
}

#if !SWIFT_PACKAGE
private final class BundleToken {}
#endif
