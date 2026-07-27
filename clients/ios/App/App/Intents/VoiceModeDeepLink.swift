import Foundation
import UIKit

/// The `<scheme>://voice?mode=…` command an App Intent hands to the web layer.
///
/// This is deliberately the *same* URL contract the SPA already parses
/// (`parseStartVoiceDeepLink` in `clients/web/src/runtime/native-deep-link.ts`,
/// routed by `runtime/event-sources/capacitor-deep-links.ts`), so the intents
/// add no second command channel: Siri, the Action Button, the Live Activity's
/// `widgetURL`, and a link typed into Safari all converge on one parser.
enum VoiceModeDeepLink: String {
    /// Start a fresh live-voice session.
    case new
    /// Bring an already-running session back on screen; the web consumer falls
    /// back to `new` when nothing is running.
    case resume

    /// Host segment shared with `START_VOICE_DEEP_LINK_HOST` on the web side.
    private static let host = "voice"

    /// The command URL for the *running build*, or `nil` when the bundle
    /// declares no usable scheme. Unlike sign-in, there is no safe fallback
    /// here: defaulting to the production scheme would make a Dev build launch
    /// voice mode in the production app.
    var url: URL? {
        guard let scheme = BundleURLScheme.current else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = Self.host
        components.queryItems = [URLQueryItem(name: "mode", value: rawValue)]
        return components.url
    }

    /// Hand this command to the shell. Returns immediately — App Intents run
    /// under a short execution budget, so `perform()` must hand off rather than
    /// wait for a session to actually start.
    @MainActor
    func route() {
        guard let url else {
            NSLog("[voice] No bundle URL scheme; dropping voice command")
            return
        }
        (UIApplication.shared.delegate as? AppDelegate)?.deliverVoiceCommand(url)
    }
}
