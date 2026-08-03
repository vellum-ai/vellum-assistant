import ActivityKit
import SwiftUI
import WidgetKit

/// The live-voice session, rendered on the Lock Screen and in the Dynamic
/// Island.
///
/// All four presentations are the same handful of facts at four sizes, composed
/// from the primitives in `VoiceSessionIslandViews.swift`; see that file for
/// the two rules they share (no native phase copy, accent as decoration only)
/// and for which facts survive into the tightest slots.
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
                startedAt: context.attributes.startedAt,
                isStale: context.isStale,
                avatarImageData: context.attributes.avatarImageData
            )
            .widgetURL(VoiceModeDeepLink.resume.url())
        } dynamicIsland: { context in
            let state = context.state
            let isStale = context.isStale
            let label = state.displayLabel(isStale: isStale)
            let detail = state.displayDetail(isStale: isStale)
            let avatar = context.attributes.avatarImageData
            let startedAt = context.attributes.startedAt
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VoiceAccentBadge(accent: state.accentColor, avatarImageData: avatar)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Elapsed time, plus the mute glyph while muted. There is
                    // still no always-present mic glyph, which would read as a
                    // control, and there are none here.
                    HStack(spacing: 6) {
                        VoiceSessionTimer(startedAt: startedAt, isStale: isStale)
                        if state.muted {
                            VoiceMuteGlyph()
                        }
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VoiceSessionText(
                        text: context.attributes.assistantName,
                        font: .headline
                    )
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // Everything the activity knows, because reaching this
                    // presentation is deliberate: it takes a touch and hold,
                    // and someone who did that is asking for the detail the
                    // inline slots had to drop. So the phase and the activity
                    // line both render here rather than competing for one row.
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            VoicePhaseGlyph(state: state, isStale: isStale)
                            VoiceSessionText(text: label, color: .secondary)
                        }
                        if !detail.isEmpty {
                            VoiceSessionText(
                                text: detail,
                                font: .caption,
                                color: .tertiary
                            )
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                VoiceCompactIdentity(accent: state.accentColor, avatarImageData: avatar)
            } compactTrailing: {
                // A few characters wide. The passed label truncates to a
                // fragment here, and the fragments for "Listening…" and
                // "Thinking…" are not worth telling apart, so the phase shows
                // as a glyph instead. A glyph is not a native *string*, which
                // is what the copy rule actually guards against; shortening
                // the wording, if it is ever wanted here, belongs to the web
                // layer that owns the wording.
                VoicePhaseGlyph(state: state, isStale: isStale, scale: .small)
            } minimal: {
                // **The presentation a voice session most likely gets.** iOS
                // shows the minimal slot when the island is shared, and a live
                // session always shares it: the system's microphone privacy
                // indicator is on for the whole call, including while muted,
                // because muting streams silence rather than stopping capture.
                //
                // So this one circle is the entire island for most of a call,
                // and it carries the phase rather than the avatar. Identity is
                // the fact that does not change and that the user already
                // knows; whether it is still listening is the one they cannot
                // get from a locked phone. The accent tint keeps identity
                // present, weakly, in the glyph's color.
                VoiceMinimalPresentation(
                    state: state,
                    isStale: isStale,
                    avatarImageData: avatar
                )
            }
            .widgetURL(VoiceModeDeepLink.resume.url())
            .keylineTint(state.accentColor)
        }
    }
}
