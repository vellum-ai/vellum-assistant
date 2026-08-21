import Foundation
#if !VOICE_ACTIVITY_EXTENSION
import UIKit
#endif

/// The one implementation of a *parameterless* `<scheme>://<host>` command:
/// build the URL for the running build, hand it to the shell.
///
/// ``CameraDeepLink`` and ``NewChatDeepLink`` are thin identities over this,
/// each naming its host and nothing else. A copy of the scheme lookup, the
/// `URLComponents` assembly or the `AppDelegate` delivery on either of them is
/// the kind of duplication that lets a fix to command provenance or delivery
/// land on one host and not the other, so anything true of every parameterless
/// command belongs here and only the host belongs on its own type.
///
/// ``VoiceModeDeepLink`` deliberately stays separate: it carries a `mode` and
/// an optional `prompt`, so its URL is built from query items this has no
/// notion of.
///
/// Lives in `Shared/` because the App Intents written in terms of these
/// commands are code in the appex. ``route(host:)`` is the one app-only piece;
/// see its docs.
enum CommandDeepLink {
    /// The command URL for the *running build*, or `nil` when the bundle
    /// declares no usable scheme. No fallback, same as voice: defaulting to the
    /// production scheme would make a Dev build drive the production app.
    static func url(host: String) -> URL? {
        guard let scheme = BundleURLScheme.current else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        return components.url
    }

    /// Hand this command to the shell. Returns immediately, since App Intents
    /// run under a short execution budget and `perform()` must hand off rather
    /// than wait for the web layer to act on it.
    ///
    /// The body is compiled out of the VoiceActivity extension, which defines
    /// `VOICE_ACTIVITY_EXTENSION`. Every intent that reaches here declares
    /// `openAppWhenRun` / `.foreground(.immediate)`, so the system performs it
    /// in the *app* process even when the tap came from a widget in the appex.
    /// Compiling the body out keeps `UIApplication.shared` (unavailable to app
    /// extensions) and `AppDelegate` (which links Capacitor, which the appex
    /// does not) out of the appex binary.
    @MainActor
    static func route(host: String) {
        #if VOICE_ACTIVITY_EXTENSION
        assertionFailure("Widget intents are performed in the app process, not the appex")
        #else
        guard let url = url(host: host) else {
            NSLog("[deep-link] No bundle URL scheme; dropping %@ command", host)
            return
        }
        (UIApplication.shared.delegate as? AppDelegate)?.deliverCommandURL(url)
        #endif
    }
}
