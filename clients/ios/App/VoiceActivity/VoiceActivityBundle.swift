import ActivityKit
import SwiftUI
import WidgetKit

/// Widget bundle entry point for the VoiceActivity extension.
///
/// The bundle currently hosts a single placeholder Live Activity. It exists so
/// the extension targets, their bundle IDs, and the embed wiring can be proven
/// green on their own — a build failure here is a *target* problem, not a
/// SwiftUI one. The real Dynamic Island and Lock Screen presentations replace
/// ``VoiceSessionLiveActivity`` in a follow-up.
@main
struct VoiceActivityBundle: WidgetBundle {
    var body: some Widget {
        VoiceSessionLiveActivity()
    }
}

/// Placeholder rendering of a running live-voice session.
///
/// Every presentation shows `context.state.label` verbatim. That is not just
/// placeholder laziness — it is the contract the real UI keeps too: the web
/// side owns all user-facing phase copy (`LIVE_VOICE_STATE_LABELS` in
/// `clients/web/src/domains/chat/voice/live-voice/live-voice-store.ts`), because
/// this shell ships on App Store cadence while that copy deploys continuously.
struct VoiceSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceSessionAttributes.self) { context in
            Text(context.state.label)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.label)
                }
            } compactLeading: {
                Text(context.state.label)
            } compactTrailing: {
                Text(context.state.label)
            } minimal: {
                Text(context.state.label)
            }
        }
    }
}
