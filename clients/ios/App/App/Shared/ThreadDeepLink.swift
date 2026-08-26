import Foundation
#if !VOICE_ACTIVITY_EXTENSION
import UIKit
#endif

/// The `<scheme>://thread/<id>?message=…` command that opens a conversation,
/// with `message` staged in its composer when one is supplied.
///
/// Mirrors the macOS shell's `vellum://thread/<id>` link (see
/// `clients/macos/src/main/deep-links.ts`) with a `message` query parameter
/// on top, and rides the same delivery seam as `VoiceModeDeepLink`, so the
/// SPA keeps a single custom-scheme parser
/// (`clients/web/src/runtime/native-deep-link.ts`, routed by
/// `runtime/event-sources/capacitor-deep-links.ts`).
///
/// Lives in `Shared/` because two very different callers build these links:
/// `SendMessageToChatIntent` in the app target, which carries a message, and
/// the Catch Up widget in the VoiceActivity extension, whose rows are plain
/// `Link`s into a conversation. ``route(message:)`` stays app-only, and unlike
/// `VoiceModeDeepLink` it is compiled out of the appex entirely rather than
/// emptied: no extension code hands a thread command to the shell, because the
/// system opens a widget's `Link` itself.
struct ThreadDeepLink {
    /// Host segment shared with `OPEN_THREAD_DEEP_LINK_HOST` on the web side.
    private static let host = "thread"

    let threadId: String

    /// The command URL for the *running build*, or `nil` when the bundle
    /// declares no usable scheme. No fallback, same as voice: sending a
    /// message to the wrong app's assistant is strictly worse than sending
    /// nothing, and a widget row that opened a different environment's app
    /// would be worse still.
    ///
    /// - Parameter message: what to stage in the conversation. Omitted from
    ///   the URL when blank, which is how the widget's rows build a link that
    ///   just opens the thread. The web parser bounds and sanitizes whatever
    ///   arrives; nothing is trusted for being locally produced.
    func url(message: String = "") -> URL? {
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

    #if !VOICE_ACTIVITY_EXTENSION
    /// Hand this command to the shell. Returns immediately: App Intents run
    /// under a short execution budget, so `perform()` must hand off rather
    /// than wait for the web layer to act.
    ///
    /// Compiled out of the VoiceActivity extension, which defines
    /// `VOICE_ACTIVITY_EXTENSION`, so `UIApplication.shared` (unavailable to
    /// app extensions) and `AppDelegate` (which links Capacitor, which the
    /// appex does not) stay out of the appex binary.
    @MainActor
    func route(message: String) {
        guard let url = url(message: message) else {
            NSLog("[thread] No bundle URL scheme; dropping send-to-chat command")
            return
        }
        (UIApplication.shared.delegate as? AppDelegate)?.deliverCommandURL(url)
    }
    #endif
}
