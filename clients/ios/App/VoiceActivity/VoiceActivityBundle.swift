import SwiftUI
import WidgetKit

/// Widget bundle entry point for the VoiceActivity extension.
///
/// One member today: the live-voice Live Activity, defined in
/// `VoiceSessionLiveActivity.swift`. A `WidgetBundle` can hold home-screen
/// widgets and controls alongside it, so anything added later joins this list
/// rather than needing another extension target.
@main
struct VoiceActivityBundle: WidgetBundle {
    var body: some Widget {
        VoiceSessionLiveActivity()
    }
}
