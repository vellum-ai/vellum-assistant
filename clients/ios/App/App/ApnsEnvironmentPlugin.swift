import Capacitor
import Foundation

/// Capacitor plugin that reports which APNs environment this build's
/// `aps-environment` entitlement actually points at, read from the embedded
/// provisioning profile. The web side
/// (`clients/web/src/runtime/apns-environment.ts`) uses it to tag device
/// tokens correctly: TestFlight signs every build, including dev-suffixed
/// bundle IDs, with the production entitlement, so any heuristic based on the
/// bundle ID misclassifies TestFlight dev builds and their pushes are
/// rejected by Apple.
///
/// The single `get` method resolves `{ environment }` with one of:
/// - `"development"`: an Xcode / development-signed install
/// - `"production"`: a TestFlight or App Store install
/// - `"unknown"`: the profile exists but could not be read or parsed
///
/// Simulator builds ship no embedded profile and always resolve
/// `"development"`, because APNs simulator push only uses the development
/// environment.
///
/// It never rejects. Per the skew rule in `clients/web/docs/CAPACITOR.md`, a
/// plugin must not require a separate availability probe, so the one result
/// encodes every state; an older shell without the plugin simply fails the
/// bridge call and the web side falls back to its heuristic.
@objc(ApnsEnvironmentPlugin)
public class ApnsEnvironmentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApnsEnvironmentPlugin"
    public let jsName = "ApnsEnvironment"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    @objc public func get(_ call: CAPPluginCall) {
        #if targetEnvironment(simulator)
            call.resolve(["environment": "development"])
            return
        #endif
        call.resolve(["environment": Self.entitlementEnvironment()])
    }

    private static func entitlementEnvironment() -> String {
        guard let profileURL = Bundle.main.url(
            forResource: "embedded",
            withExtension: "mobileprovision"
        ) else {
            // App Store installs ship no embedded profile and are always production.
            return "production"
        }
        guard let profileData = try? Data(contentsOf: profileURL) else {
            return "unknown"
        }

        // The profile is a CMS blob wrapping a plist, so it is scanned as text
        // rather than decoded. `String(decoding:as:)` is lossy: the wrapper's
        // binary segments become replacement characters while the ASCII plist
        // entries stay intact.
        let text = String(decoding: profileData, as: UTF8.self)
        guard let key = text.range(of: "<key>aps-environment</key>"),
              let open = text.range(of: "<string>", range: key.upperBound..<text.endIndex),
              let close = text.range(of: "</string>", range: open.upperBound..<text.endIndex)
        else {
            return "unknown"
        }

        let value = text[open.upperBound..<close.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        switch value {
        case "development", "production":
            return value
        default:
            return "unknown"
        }
    }
}
