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
                    // Inset and sized down from the Lock Screen's mark: this
                    // region is shallow, and an avatar that fills it edge to
                    // edge reads as cropped rather than as a portrait.
                    VoiceAccentBadge(
                        accent: state.accentColor,
                        avatarImageData: avatar,
                        diameter: 28
                    )
                    .padding(.leading, 6)
                    .padding(.vertical, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Elapsed time, plus the mute glyph while muted. There is
                    // still no always-present mic glyph, which would read as a
                    // control, and there are none here.
                    //
                    // Centered against the region's full height, like the row
                    // beside it: left to itself this content hugs the top,
                    // which puts the timer on a line of its own above the name
                    // and undoes the single row.
                    HStack(spacing: 6) {
                        VoiceSessionTimer(startedAt: startedAt, isStale: isStale)
                        if state.muted {
                            VoiceMuteGlyph()
                        }
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                DynamicIslandExpandedRegion(.center) {
                    // One line: name, then phase, reading left to right from
                    // the avatar to the timer. Stacking them split this row
                    // into fragments that each belonged to a different edge.
                    HStack(spacing: 6) {
                        VoiceSessionText(
                            text: context.attributes.assistantName,
                            font: .subheadline
                        )
                        VoicePhaseGlyph(
                            state: state,
                            isStale: isStale,
                            scale: .small
                        )
                        VoiceSessionText(
                            text: label,
                            font: .caption,
                            color: .secondary
                        )
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // The activity line gets the full-width row to itself, and
                    // takes no space when there is none: an empty bottom
                    // region collapses, so an idle session's island is the
                    // header row alone rather than a header and a gap.
                    if !detail.isEmpty {
                        VoiceSessionText(
                            text: detail,
                            font: .caption,
                            color: .tertiary
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
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
                // **The presentation a call gets on a device.** A session holds
                // the microphone for the whole call, muted included (muting
                // streams silence rather than stopping capture), so the system
                // privacy indicator shares the island and iOS falls back to
                // this slot.
                //
                // A simulator shows the compact presentation instead, because
                // its microphone is mocked and raises no indicator. That makes
                // a simulator screenshot void as evidence here, the same way it
                // is for anything else about audio.
                //
                // So this one circle is the island for most of a call, and it
                // carries the phase: identity is the fact that does not change
                // and that the user already knows, while whether it is still
                // listening is the one they cannot get from a locked phone. The
                // accent tint keeps identity weakly present in the glyph color.
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
