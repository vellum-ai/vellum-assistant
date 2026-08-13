import Foundation
import UIKit

/// The `<scheme>://thread/<id>?message=…` command `SendMessageToChatIntent`
/// hands to the web layer: open the given conversation with `message` staged
/// in its composer.
///
/// Mirrors the macOS shell's `vellum://thread/<id>` link (see
/// `clients/macos/src/main/deep-links.ts`) with a `message` query parameter
/// on top, and rides the same delivery seam as `VoiceModeDeepLink`, so the
/// SPA keeps a single custom-scheme parser
/// (`clients/web/src/runtime/native-deep-link.ts`, routed by
/// `runtime/event-sources/capacitor-deep-links.ts`).
///
/// Lives in the app target only: no extension builds these links, so unlike
/// `VoiceModeDeepLink` there is nothing to share and no compiled-out body.
struct ThreadDeepLink {
    /// Host segment shared with `OPEN_THREAD_DEEP_LINK_HOST` on the web side.
    private static let host = "thread"

    let threadId: String

    /// The command URL for the *running build*, or `nil` when the bundle
    /// declares no usable scheme. No fallback, same as voice: sending a
    /// message to the wrong app's assistant is strictly worse than sending
    /// nothing.
    ///
    /// - Parameter message: what to stage in the conversation. Omitted from
    ///   the URL when blank, so such a link degrades to just opening the
    ///   thread. The web parser bounds and sanitizes whatever arrives;
    ///   nothing is trusted for being locally produced.
    func url(message: String) -> URL? {
        guard let scheme = BundleURLScheme.current else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = Self.host
        components.path = "/" + threadId
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty,
           let encoded = trimmed.addingPercentEncoding(
               withAllowedCharacters: .deepLinkQueryValueAllowed
           ) {
            components.percentEncodedQueryItems = [
                URLQueryItem(name: "message", value: encoded)
            ]
        }
        return components.url
    }

    /// Hand this command to the shell. Returns immediately: App Intents run
    /// under a short execution budget, so `perform()` must hand off rather
    /// than wait for the web layer to act.
    @MainActor
    func route(message: String) {
        guard let url = url(message: message) else {
            NSLog("[thread] No bundle URL scheme; dropping send-to-chat command")
            return
        }
        (UIApplication.shared.delegate as? AppDelegate)?.deliverCommandURL(url)
    }
}
