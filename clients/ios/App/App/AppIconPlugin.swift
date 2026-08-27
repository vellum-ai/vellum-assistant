import Capacitor
import Foundation
import UIKit

/// Capacitor plugin exposing the alternate app icons this build ships, so the
/// web layer (`clients/web/src/runtime/app-icon.ts`) can put the icon a user
/// picked in Settings on the home screen.
///
/// Methods:
/// - `getState` resolves `{ supported, current, available }`. `available` is
///   read from the bundle's `CFBundleIcons` -> `CFBundleAlternateIcons`, so the
///   shell is the source of truth for which names exist and the web side
///   validates its computed name against that list instead of guessing.
/// - `set({ name })` swaps the icon, or restores the primary one when `name` is
///   null or absent.
///
/// Per the skew rule in `clients/web/docs/CAPACITOR.md`, one result shape
/// encodes every state and neither method rejects: a build with no alternates
/// resolves an empty `available`, and a refused icon swap resolves
/// `{ok: false, error}` rather than rejecting. An older shell without the
/// plugin fails the bridge call, which the web side reads as the feature being
/// off.
@objc(AppIconPlugin)
public class AppIconPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppIconPlugin"
    public let jsName = "AppIcon"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    @objc public func getState(_ call: CAPPluginCall) {
        // `UIApplication` is main-actor only, so every read runs on the main
        // queue even though the bundle scan below does not need it.
        DispatchQueue.main.async {
            let application = UIApplication.shared
            call.resolve([
                "supported": application.supportsAlternateIcons,
                "current": Self.nullable(application.alternateIconName),
                "available": Self.alternateIconNames(),
            ])
        }
    }

    @objc public func set(_ call: CAPPluginCall) {
        let name = call.getString("name")
        DispatchQueue.main.async {
            UIApplication.shared.setAlternateIconName(name) { error in
                if let error {
                    call.resolve(["ok": false, "error": error.localizedDescription])
                    return
                }
                call.resolve(["ok": true])
            }
        }
    }

    /// Alternate icon names declared in `Info.plist`, sorted so the list is
    /// stable across launches (`CFBundleAlternateIcons` is a dictionary).
    private static func alternateIconNames() -> [String] {
        guard
            let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any],
            let alternates = icons["CFBundleAlternateIcons"] as? [String: Any]
        else {
            return []
        }
        return alternates.keys.sorted()
    }

    private static func nullable(_ value: String?) -> Any {
        if let value {
            return value
        }
        return NSNull()
    }
}
