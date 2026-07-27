import ActivityKit
import SwiftUI
import WidgetKit

/// The live-voice session, rendered on the Lock Screen and in the Dynamic
/// Island.
///
/// All four presentations are the same three facts at four sizes, composed
/// from the primitives in `VoiceSessionIslandViews.swift`; see that file for
/// the two rules they share (no native phase copy, accent as decoration only).
///
/// **There are no interactive controls, by design.** An in-island end button
/// would need a `LiveActivityIntent` plus a signalling path into the running
/// app, and it contradicts the voice room's established invariant that the
/// room is a full-app takeover whose ✕ is the only exit. Tap-to-return is the
/// single affordance, so both halves of "look at it" and "act on it" resolve
/// to the same place: the room.
struct VoiceSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceSessionAttributes.self) { context in
            VoiceSessionLockScreenView(
                assistantName: context.attributes.assistantName,
                state: context.state
            )
            .widgetURL(VoiceSessionDeepLink.resume)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VoiceAccentBadge(accent: state.accentColor)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Nothing to say when unmuted: an always-present mic glyph
                    // would read as a control, and there are none here.
                    if state.muted {
                        VoiceMuteGlyph()
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VoiceSessionText(text: state.label, font: .headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VoiceSessionText(
                        text: context.attributes.assistantName,
                        color: .secondary
                    )
                }
            } compactLeading: {
                VoiceAccentGlyph(accent: state.accentColor, scale: .small)
            } compactTrailing: {
                // The tightest slot there is. It still shows the passed label,
                // truncated — substituting a shorter native string here is
                // precisely the fossilization this design avoids.
                VoiceSessionText(text: state.label, font: .caption2, color: .secondary)
            } minimal: {
                VoiceAccentGlyph(accent: state.accentColor, scale: .small)
            }
            .widgetURL(VoiceSessionDeepLink.resume)
            .keylineTint(state.accentColor)
        }
    }
}
