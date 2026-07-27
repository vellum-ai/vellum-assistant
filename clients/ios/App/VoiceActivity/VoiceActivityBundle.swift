import SwiftUI
import WidgetKit

/// Widget bundle entry point for the VoiceActivity extension.
///
/// Two members: the live-voice Live Activity (`VoiceSessionLiveActivity.swift`)
/// and the Control Center / Lock Screen control (`StartVoiceControl.swift`). A
/// `WidgetBundle` can hold home-screen widgets alongside them, so anything
/// added later joins this list rather than needing another extension target.
///
/// The control is `@available(iOS 18.0, *)` while the app deploys to 17.0, so
/// it is listed under an `#available` check — the one shape that works here.
/// `WidgetBundleBuilder.buildOptional` is `@available(*, unavailable)` for a
/// plain `if`, and its overload accepting a `ControlWidget` exists only on
/// iOS 18+, so an `#available` block is what routes the control through it.
/// Listing the control unconditionally would not compile, and annotating the
/// *bundle* instead would drag the Live Activity up to iOS 18 with it.
@main
struct VoiceActivityBundle: WidgetBundle {
    var body: some Widget {
        VoiceSessionLiveActivity()
        if #available(iOS 18.0, *) {
            StartVoiceControl()
        }
    }
}
