import AppIntents
import SwiftUI
import WidgetKit

/// One-tap "New voice conversation" for Control Center and the Lock Screen.
///
/// A `ControlWidget` in this bundle is offered in the Control Center gallery
/// and, on hardware with a customizable Lock Screen control slot, as a Lock
/// Screen control — one declaration, both placements.
///
/// The action is `StartNewVoiceConversationIntent` verbatim, the same type Siri
/// and the Action Button run, so every surface starts a session through the one
/// `<scheme>://voice?mode=new` contract instead of growing a second route to
/// keep in sync. It is deliberately the *new*-conversation intent rather than
/// `StartVoiceModeIntent`: a control, like a physical button, should do the
/// same thing every time it is pressed.
///
/// Its title and gallery copy are read off that intent rather than restated, so
/// the action cannot drift into reading like a different feature in Control
/// Center than it does in Siri. `waveform` matches the Live Activity's accent
/// glyph (`VoiceAccentGlyph`), tying the control to the island that follows it.
///
/// **iOS 18+.** `ControlWidget` did not exist before then and the app deploys
/// to 17.0, so this is availability-gated: on 17.x the app installs and its
/// Live Activity behaves exactly as before, there is simply no control in the
/// gallery.
@available(iOS 18.0, *)
struct StartVoiceControl: ControlWidget {
    /// Stable identity for this control. iOS keys a user's placements off it,
    /// so changing it orphans every control the user has already placed.
    private static let kind = "new-voice-conversation"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: StartNewVoiceConversationIntent()) {
                Label {
                    Text(StartNewVoiceConversationIntent.title)
                } icon: {
                    Image(systemName: "waveform")
                }
            }
        }
        .displayName(StartNewVoiceConversationIntent.title)
        .description(StartNewVoiceConversationIntent.description.descriptionText)
    }
}
