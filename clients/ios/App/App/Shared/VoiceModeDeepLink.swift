import Foundation
#if !VOICE_ACTIVITY_EXTENSION
import UIKit
#endif

/// The `<scheme>://voice?mode=…` command an App Intent hands to the web layer.
///
/// This is deliberately the *same* URL contract the SPA already parses
/// (`parseStartVoiceDeepLink` in `clients/web/src/runtime/native-deep-link.ts`,
/// routed by `runtime/event-sources/capacitor-deep-links.ts`), so the intents
/// add no second command channel: Siri, the Action Button, the Control Center
/// control, the Live Activity's `widgetURL`, and a link typed into Safari all
/// converge on one parser.
///
/// Lives in `Shared/` because the VoiceActivity extension needs it too. The
/// Live Activity's `widgetURL` builds ``resume``'s URL, and the Control Center
/// control needs `StartNewVoiceConversationIntent` — defined in terms of this
/// type — to compile. ``route()`` is the one app-only piece; see its docs.
enum VoiceModeDeepLink: String {
    /// Start a fresh live-voice session.
    case new
    /// Bring an already-running session back on screen; the web consumer falls
    /// back to `new` when nothing is running.
    case resume

    /// Host segment shared with `START_VOICE_DEEP_LINK_HOST` on the web side.
    private static let host = "voice"

    /// Characters left unescaped in a query *value*.
    ///
    /// `URLComponents.queryItems` encodes with `urlQueryAllowed`, which permits
    /// the sub-delimiters `&`, `=`, `+`, and `?`. That is correct for a whole
    /// query string and wrong for a single value inside one: a spoken
    /// "Ben & Jerry's" would arrive at the parser as a `prompt` of "Ben " plus a
    /// stray `Jerry's` parameter. Removing those four and assigning through
    /// `percentEncodedQueryItems` is the standard fix — the value is escaped
    /// once, by us, with delimiters included.
    private static let queryValueAllowed: CharacterSet = {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        return allowed
    }()

    /// The command URL for the *running build*, or `nil` when the bundle
    /// declares no usable scheme. Unlike sign-in, there is no safe fallback
    /// here: defaulting to the production scheme would make a Dev build launch
    /// voice mode in the production app.
    ///
    /// - Parameter prompt: what the user already said, when the command came
    ///   from `AskVellumIntent`. Omitted from the URL when `nil` or blank, so a
    ///   plain launch intent produces the byte-identical URL it always has.
    ///   The web parser bounds and sanitizes whatever arrives; nothing is
    ///   trusted for being locally produced.
    func url(prompt: String? = nil) -> URL? {
        guard let scheme = BundleURLScheme.current else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = Self.host
        var items = [URLQueryItem(name: "mode", value: rawValue)]
        let trimmed = prompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty,
           let encoded = trimmed.addingPercentEncoding(
               withAllowedCharacters: Self.queryValueAllowed
           ) {
            items.append(URLQueryItem(name: "prompt", value: encoded))
        }
        components.percentEncodedQueryItems = items
        return components.url
    }

    /// Hand this command to the shell. Returns immediately — App Intents run
    /// under a short execution budget, so `perform()` must hand off rather than
    /// wait for a session to actually start.
    ///
    /// The body is compiled out of the VoiceActivity extension, which defines
    /// `VOICE_ACTIVITY_EXTENSION`. Both callers declare `openAppWhenRun` /
    /// `.foreground(.immediate)`, so the system performs them in the *app*
    /// process even when the tap came from the extension's Control Center
    /// control — the appex needs the intent type to exist, never to run it.
    /// Compiling the body out keeps `UIApplication.shared` (unavailable to app
    /// extensions) and `AppDelegate` (which links Capacitor, which the appex
    /// does not) out of the appex binary.
    @MainActor
    func route(prompt: String? = nil) {
        #if VOICE_ACTIVITY_EXTENSION
        assertionFailure("Voice intents are performed in the app process, not the appex")
        #else
        guard let url = url(prompt: prompt) else {
            NSLog("[voice] No bundle URL scheme; dropping voice command")
            return
        }
        (UIApplication.shared.delegate as? AppDelegate)?.deliverVoiceCommand(url)
        #endif
    }
}
