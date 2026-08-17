import AppIntents
import SwiftUI
import WidgetKit

/// One-tap "Open Vellum" for Control Center and the Lock Screen.
///
/// The app-launcher control other chat apps ship: tap the logo, be in the
/// app. The action is `OpenVellumIntent`, which does nothing beyond
/// foregrounding the app; state (which conversation, which screen) is the
/// app's to restore, not the control's to dictate.
///
/// Title and gallery copy are read off the intent rather than restated, so
/// the control cannot drift into reading like a different action in Control
/// Center than it does in the Shortcuts app.
///
/// The glyph is the custom `VellumV` symbol (`Assets.xcassets` in this
/// extension), the same "V" every app icon variant draws. A control is
/// identified by its glyph alone once placed, and no system symbol reads as
/// Vellum.
///
/// **iOS 18+.** `ControlWidget` did not exist before then and the app deploys
/// to 17.0, so this is availability-gated exactly like `StartVoiceControl`:
/// on 17.x the app installs and behaves as before, there is simply no control
/// in the gallery.
@available(iOS 18.0, *)
struct OpenVellumControl: ControlWidget {
    /// Stable identity for this control. iOS keys a user's placements off it,
    /// so changing it orphans every control the user has already placed.
    private static let kind = "open-app"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenVellumIntent()) {
                Label {
                    Text(OpenVellumIntent.title)
                } icon: {
                    Image("VellumV")
                }
            }
        }
        .displayName(OpenVellumIntent.title)
        .description(OpenVellumIntent.description.descriptionText)
    }
}
