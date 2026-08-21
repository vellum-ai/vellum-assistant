import Foundation
#if !VOICE_ACTIVITY_EXTENSION
import UIKit
#endif

/// The `<scheme>://camera` command a Home Screen widget hands to the web
/// layer: land in the composer with the camera up, so the next photo is an
/// attachment rather than a trip through the photo library.
///
/// Deliberately the *same* URL contract the SPA already parses
/// (`parseOpenCameraDeepLink` in `clients/web/src/runtime/native-deep-link.ts`,
/// routed by `runtime/event-sources/capacitor-deep-links.ts`), so a widget tap
/// adds no second command channel. It carries no parameters: the host is the
/// whole request.
///
/// Lives in `Shared/` because `OpenCameraIntent` is written in terms of it and
/// a widget button is code in the appex. ``route()`` is the one app-only
/// piece; see its docs.
enum CameraDeepLink {
    /// Host segment shared with `CAMERA_DEEP_LINK_HOST` on the web side.
    private static let host = "camera"

    /// The command URL for the *running build*, or `nil` when the bundle
    /// declares no usable scheme. No fallback, same as voice: defaulting to
    /// the production scheme would make a Dev build open the camera in the
    /// production app.
    static func url() -> URL? {
        guard let scheme = BundleURLScheme.current else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        return components.url
    }

    /// Hand this command to the shell. Returns immediately, since App Intents
    /// run under a short execution budget and `perform()` must hand off rather
    /// than wait for the composer to mount.
    ///
    /// The body is compiled out of the VoiceActivity extension, which defines
    /// `VOICE_ACTIVITY_EXTENSION`. `OpenCameraIntent` declares
    /// `openAppWhenRun` / `.foreground(.immediate)`, so the system performs it
    /// in the *app* process even when the tap came from a widget in the appex.
    /// Compiling the body out keeps `UIApplication.shared` (unavailable to app
    /// extensions) and `AppDelegate` (which links Capacitor, which the appex
    /// does not) out of the appex binary.
    @MainActor
    static func route() {
        #if VOICE_ACTIVITY_EXTENSION
        assertionFailure("Widget intents are performed in the app process, not the appex")
        #else
        guard let url = url() else {
            NSLog("[camera] No bundle URL scheme; dropping camera command")
            return
        }
        (UIApplication.shared.delegate as? AppDelegate)?.deliverCommandURL(url)
        #endif
    }
}
