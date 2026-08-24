import SwiftUI
import WidgetKit

/// Widget bundle entry point for the VoiceActivity extension.
///
/// Six members: the live-voice Live Activity
/// (`VoiceSessionLiveActivity.swift`), three Home Screen widgets, Catch Up
/// (`Widgets/CatchUpWidget.swift`), Status (`Widgets/StatusWidget.swift`),
/// and Quick Actions (`Widgets/QuickActionsWidget.swift`), and two Control
/// Center / Lock Screen controls, one starting a voice conversation
/// (`StartVoiceControl.swift`) and one opening the app
/// (`OpenVellumControl.swift`). A `WidgetBundle` holds Home Screen widgets
/// alongside the rest, which is why the widgets join this list rather than
/// needing another extension target.
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
        CatchUpWidget()
        StatusWidget()
        QuickActionsWidget()
        if #available(iOS 18.0, *) {
            StartVoiceControl()
            OpenVellumControl()
        }
    }
}
