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
///
/// The tap target is `VoiceModeDeepLink.resume`, the same shared contract the
/// App Intents use: it foregrounds the app into the live voice room, falling
/// through to a fresh session if the app was killed and the session is gone.
/// Its URL is built from *this* build's own scheme, so a Dev island opens the
/// Dev app even with production installed — and is `nil` on a build that
/// declares no scheme, which correctly leaves the presentation untappable
/// (`.widgetURL(_:)` takes an optional) rather than sending a Dev island into
/// the production app.
struct VoiceSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceSessionAttributes.self) { context in
            VoiceSessionLockScreenView(
                assistantName: context.attributes.assistantName,
                state: context.state,
                isStale: context.isStale,
                avatarImageData: context.attributes.avatarImageData
            )
            .widgetURL(VoiceModeDeepLink.resume.url())
        } dynamicIsland: { context in
            let state = context.state
            let label = state.displayLabel(isStale: context.isStale)
            let avatar = context.attributes.avatarImageData
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VoiceAccentBadge(accent: state.accentColor, avatarImageData: avatar)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Nothing to say when unmuted: an always-present mic glyph
                    // would read as a control, and there are none here.
                    if state.muted {
                        VoiceMuteGlyph()
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VoiceSessionText(text: label, font: .headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VoiceSessionText(
                        text: context.attributes.assistantName,
                        color: .secondary
                    )
                }
            } compactLeading: {
                VoiceCompactIdentity(accent: state.accentColor, avatarImageData: avatar)
            } compactTrailing: {
                // The tightest slot there is. It still shows the passed label,
                // truncated — substituting a shorter native string here is
                // precisely the fossilization this design avoids.
                VoiceSessionText(text: label, font: .caption2, color: .secondary)
            } minimal: {
                VoiceCompactIdentity(accent: state.accentColor, avatarImageData: avatar)
            }
            .widgetURL(VoiceModeDeepLink.resume.url())
            .keylineTint(state.accentColor)
        }
    }
}
