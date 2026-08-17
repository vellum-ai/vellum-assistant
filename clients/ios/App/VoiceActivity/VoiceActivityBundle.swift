import SwiftUI
import WidgetKit

/// Widget bundle entry point for the VoiceActivity extension.
///
/// Three members: the live-voice Live Activity
/// (`VoiceSessionLiveActivity.swift`) and two Control Center / Lock Screen
/// controls, one starting a voice conversation (`StartVoiceControl.swift`) and
/// one opening the app (`OpenVellumControl.swift`). A `WidgetBundle` can hold
/// home-screen widgets alongside them, so anything added later joins this list
/// rather than needing another extension target.
///
/// The controls are `@available(iOS 18.0, *)` while the app deploys to 17.0,
/// so they are listed under an `#available` check, the one shape that works
/// here. `WidgetBundleBuilder.buildOptional` is `@available(*, unavailable)`
/// for a plain `if`, and its overloads accepting a `ControlWidget` exist only
/// on iOS 18+, so an `#available` block is what routes the controls through
/// them. Listing a control unconditionally would not compile, and annotating
/// the *bundle* instead would drag the Live Activity up to iOS 18 with it.
@main
struct VoiceActivityBundle: WidgetBundle {
    var body: some Widget {
        VoiceSessionLiveActivity()
        if #available(iOS 18.0, *) {
            StartVoiceControl()
            OpenVellumControl()
        }
    }
}
