import Foundation

/// The `<scheme>://camera` command a Home Screen widget hands to the web
/// layer: land in the composer with the camera up, so the next photo is an
/// attachment rather than a trip through the photo library.
///
/// Deliberately the *same* URL contract the SPA already parses
/// (`parseOpenCameraDeepLink` in `clients/web/src/runtime/native-deep-link.ts`,
/// routed by `runtime/event-sources/capacitor-deep-links.ts`), so a widget tap
/// adds no second command channel. It carries no parameters: the host is the
/// whole request, and the parser rejects a URL that carries a path.
///
/// A thin identity over ``CommandDeepLink``, which owns the scheme lookup, the
/// URL assembly and the delivery every parameterless command shares. This type
/// is where the host lives, next to the one parser it is shared with.
///
/// Lives in `Shared/` because `OpenCameraIntent` is written in terms of it and
/// a widget button is code in the appex.
enum CameraDeepLink {
    /// Host segment shared with `CAMERA_DEEP_LINK_HOST` on the web side.
    private static let host = "camera"

    /// Hand this command to the shell; see ``CommandDeepLink/route(host:)``.
    @MainActor
    static func route() {
        CommandDeepLink.route(host: host)
    }
}
