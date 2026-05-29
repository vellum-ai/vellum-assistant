import Foundation

private func bundleHasVellumSharedResources(_ bundle: Bundle) -> Bool {
    bundle.url(forResource: "lucide-icon-manifest", withExtension: "json") != nil
        && bundle.url(forResource: "llm-provider-catalog", withExtension: "json") != nil
}

private func vellumSharedBundle(at url: URL) -> Bundle? {
    guard FileManager.default.fileExists(atPath: url.path),
          let bundle = Bundle(url: url),
          bundleHasVellumSharedResources(bundle) else {
        return nil
    }
    return bundle
}

extension Bundle {
    /// The resource bundle containing vendored Lucide icon assets.
    ///
    /// SPM's auto-generated `Bundle.module` uses `Bundle.main.bundleURL` which resolves
    /// to the `.app` root. macOS codesigning requires resources inside `Contents/Resources/`,
    /// so SPM's accessor fails in `.app` bundles. This helper checks `resourceURL` first
    /// (correct for .app), then falls back to executable adjacency, `bundleURL`
    /// adjacency, and the bundle containing this module in XCTest.
    public static let vellumShared: Bundle = {
        let bundleNames = [
            "vellum-assistant_VellumAssistantShared",
            "VellumAssistantShared_VellumAssistantShared",
        ]

        for bundleName in bundleNames {
            // .app bundle: Contents/Resources/
            if let url = Bundle.main.resourceURL?.appendingPathComponent("\(bundleName).bundle"),
               let bundle = vellumSharedBundle(at: url) {
                return bundle
            }

            // SPM direct build and tests: alongside the executable.
            if let executableDirectory = Bundle.main.executableURL?.deletingLastPathComponent(),
               let bundle = vellumSharedBundle(at: executableDirectory.appendingPathComponent("\(bundleName).bundle")) {
                return bundle
            }

            // Fallback for launch contexts where bundleURL points at the executable directory.
            if let bundle = vellumSharedBundle(at: Bundle.main.bundleURL.appendingPathComponent("\(bundleName).bundle")) {
                return bundle
            }
        }

        #if canImport(ObjectiveC)
        // XCTest can load package resources directly into the test bundle.
        let tokenBundle = Bundle(for: BundleToken.self)
        if bundleHasVellumSharedResources(tokenBundle) {
            return tokenBundle
        }

        // Xcode framework build: look adjacent to the framework binary.
        for bundleName in bundleNames {
            if let url = Bundle(for: BundleToken.self).resourceURL?.appendingPathComponent("\(bundleName).bundle"),
               let bundle = vellumSharedBundle(at: url) {
                return bundle
            }
        }
        #endif

        // Xcode's xctest runner receives the package test bundle path as an
        // argument; SwiftPM places dependency resource bundles beside it.
        for argument in CommandLine.arguments {
            let argumentURL = URL(fileURLWithPath: argument)
            let candidateDirectories = [
                argumentURL.deletingLastPathComponent(),
                argumentURL,
            ]
            for directory in candidateDirectories {
                for bundleName in bundleNames {
                    if let bundle = vellumSharedBundle(at: directory.appendingPathComponent("\(bundleName).bundle")) {
                        return bundle
                    }
                }
            }
        }

        for bundle in Bundle.allBundles + Bundle.allFrameworks {
            if bundleHasVellumSharedResources(bundle) {
                return bundle
            }

            for bundleName in bundleNames {
                if let url = bundle.resourceURL?.appendingPathComponent("\(bundleName).bundle"),
                   let sharedBundle = vellumSharedBundle(at: url) {
                    return sharedBundle
                }
            }
        }

        #if DEBUG
        if ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" {
            return Bundle.main
        }
        #endif

        // Fallback to main bundle — assets may be embedded directly.
        return Bundle.main
    }()
}

#if canImport(ObjectiveC)
private final class BundleToken {}
#endif
