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
                    HStack(spacing: 6) {
                        VoicePhaseGlyph(state: state, isStale: isStale)
                        VoiceSessionText(text: label, font: .headline)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // The activity line takes this row while there is one, and
                    // the assistant's name takes it otherwise. Not both: the
                    // expanded island is one line tall here, and of the two,
                    // what the assistant is *doing* is the one that changes and
                    // the one the user opened the island to find out. Identity
                    // is already carried by the avatar in the leading region.
                    VoiceSessionText(
                        text: detail.isEmpty ? context.attributes.assistantName : detail,
                        color: .secondary
                    )
                }
            } compactLeading: {
                VoiceCompactIdentity(accent: state.accentColor, avatarImageData: avatar)
            } compactTrailing: {
                // The tightest slot there is, and the presentation the user
                // spends the most time looking at. It used to show the passed
                // label truncated, which at this width is two or three
                // characters, identical for "Listening…" and "Thinking…". The
                // glyph says the same thing legibly, and says it without
                // substituting a native *string*, which is the fossilization
                // this design actually guards against.
                VoicePhaseGlyph(state: state, isStale: isStale, scale: .small)
            } minimal: {
                VoiceCompactIdentity(accent: state.accentColor, avatarImageData: avatar)
            }
            .widgetURL(VoiceModeDeepLink.resume.url())
            .keylineTint(state.accentColor)
        }
    }
}
