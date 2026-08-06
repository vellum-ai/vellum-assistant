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
/// **The two roomy presentations carry the call's controls** — mute the mic,
/// mute the assistant, end it (``VoiceSessionControls``). They are the voice
/// room's own control row, because for a session whose app is not on screen
/// this IS that row, and because the alternative for a locked phone was to
/// unlock it, wait for the app, and find the room. The two tight
/// presentations stay pure status: a control a few points wide, reachable
/// with no gesture at all, is a control a pocket can press.
///
/// This reverses an earlier "no interactive controls, by design", which rested
/// on the room being the single place to act. Two things dissolved that. The
/// room stopped being a takeover — it minimizes and the session runs on — so
/// "act on the call" was already not room-shaped; and `LiveActivityIntent`
/// turns out to need no signalling path worth the name, because iOS performs
/// it in the app process, where the session already is.
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
            let approvalRequestId = state.displayApprovalRequestId(isStale: isStale)
            let avatar = context.attributes.avatarImageData
            let startedAt = context.attributes.startedAt
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VoiceAccentBadge(accent: state.accentColor, avatarImageData: avatar)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Elapsed time alone. The mute glyph that used to sit
                    // beside it is redundant now that the bottom region
                    // carries a mic button whose own icon shows the same
                    // state.
                    VoiceSessionTimer(startedAt: startedAt, isStale: isStale)
                }
                DynamicIslandExpandedRegion(.center) {
                    VoiceSessionText(
                        text: context.attributes.assistantName,
                        font: .headline
                    )
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // Everything the activity knows, plus everything it can
                    // do, because reaching this presentation is deliberate: it
                    // takes a touch and hold, and someone who did that is
                    // asking for what the inline slots had to drop. So the
                    // phase, the activity line, and the controls all render
                    // here rather than competing for one row.
                    //
                    // The controls are also why this is the only expanded
                    // region that could carry them: leading and trailing are
                    // the narrow shoulders beside the camera, and center is
                    // one line tall.
                    VStack(alignment: .leading, spacing: 10) {
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

                        // A pending decision gets its own row above the
                        // controls, on the same reasoning as the Lock Screen
                        // card: the turn is blocked, and this is a surface the
                        // user can reach without leaving what they are doing.
                        if let approvalRequestId {
                            VoiceApprovalControls(requestId: approvalRequestId)
                                .frame(maxWidth: .infinity, alignment: .center)
                        }

                        VoiceSessionControls(
                            muted: state.muted,
                            outputMuted: state.outputMuted
                        )
                        .frame(maxWidth: .infinity, alignment: .center)
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
