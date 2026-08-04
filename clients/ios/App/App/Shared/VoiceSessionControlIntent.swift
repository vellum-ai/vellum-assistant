import AppIntents
import Foundation

/// The three things the Live Activity can do to a running voice session: mute
/// the microphone, mute the assistant's audio, and end the session.
///
/// Deliberately the same three the voice room's control row carries
/// (`clients/web/src/domains/chat/voice/voice-room/voice-room.tsx`), in the same
/// order, because the island IS that row when the app is not on screen. It is
/// not a second, smaller feature with controls of its own choosing.
///
/// **Each mute is an absolute command carrying the state the button promised,
/// not a toggle.** This was a toggle first, on the reasoning that the island
/// renders a `ContentState` which can be seconds stale — so let the layer that
/// owns the session resolve it. That is backwards: the user does not act on the
/// session's hidden state, they act on the label in front of them. A button
/// reading "Mute assistant" over a session that is *already* muted toggles to
/// unmuted, which is the exact opposite of what it offered.
///
/// The stale case is real (the APNs path composes content without
/// `outputMuted`, so it decodes `false`), which is precisely why the resolution
/// has to favour the user's expressed intent. Sending what the button said
/// makes a press against a stale island a *no-op* — the session is already in
/// the requested state — instead of an inversion. A no-op is self-correcting:
/// the next push repaints the button the right way round. An inversion is a
/// bug the user has to notice and undo.
enum VoiceSessionControlAction: String, AppEnum {
    /// Stop capture, so the assistant stops hearing you.
    case muteMicrophone
    /// Resume capture.
    case unmuteMicrophone
    /// Silence playback. The assistant's turn keeps running underneath and the
    /// transcript keeps filling.
    case muteAssistantAudio
    /// Resume playback, dropping back into the reply wherever it has reached.
    case unmuteAssistantAudio
    /// End the session.
    case endSession
    /// Allow the tool call the turn is blocked on.
    ///
    /// **The two decisions carry a request id and the rest carry nothing**,
    /// and that difference is the point rather than a detail of plumbing. A
    /// mute aimed at a stale island is a no-op the next push corrects, so it
    /// can safely say only *what* to do. A decision aimed at a stale island
    /// would answer a question the user was never asked — the request it was
    /// drawn against can be decided in the app, time out, or be superseded
    /// between the push and the press — so it must also say *what it is
    /// answering*, and be dropped when that no longer matches.
    case approveRequest
    /// Deny the tool call the turn is blocked on.
    case denyRequest

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        "Voice session control"
    }

    static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
        [
            .muteMicrophone: "Mute microphone",
            .unmuteMicrophone: "Unmute microphone",
            .muteAssistantAudio: "Mute assistant audio",
            .unmuteAssistantAudio: "Unmute assistant audio",
            .endSession: "End voice session",
            .approveRequest: "Approve the pending request",
            .denyRequest: "Deny the pending request",
        ]
    }
}

/// The App Intent behind every Live Activity button.
///
/// **`LiveActivityIntent`, not `AppIntent`, and that choice is the whole
/// design.** It is the variant iOS performs *in the app process* without
/// foregrounding it — which is exactly what a Lock Screen control needs, and
/// the opposite of what the voice-launching intents want. Those declare
/// `openAppWhenRun` / `.foreground(.immediate)` because starting a conversation
/// means putting the room on screen; muting a call you are already on must
/// emphatically not unlock the phone and open an app.
///
/// The app process is also where the session already lives. Everything about a
/// live-voice call — the socket, the mic, TTS playback — is in the web layer
/// inside this process's `WKWebView`, so the control does not need a network
/// call, a credential, or an endpoint. It needs to reach across the Capacitor
/// bridge, which is one hop, and that hop is
/// ``VoiceLiveActivityPlugin/deliverControl(_:)``.
///
/// Lives in `Shared/` for the same reason `VoiceModeDeepLink` does: the appex
/// has to be able to *name* this type to put a `Button(intent:)` in the
/// activity, even though it never runs it. See ``perform()`` for how the body
/// is kept out of the extension binary.
///
/// Not offered to Shortcuts or Siri (`isDiscoverable == false`). "Toggle
/// microphone" is meaningless without a running session to toggle it on, and a
/// shortcut that silently no-ops is worse than no shortcut.
///
/// Reference:
/// https://developer.apple.com/documentation/appintents/liveactivityintent
struct VoiceSessionControlIntent: LiveActivityIntent {
    static var title: LocalizedStringResource { "Voice session control" }
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Action")
    var action: VoiceSessionControlAction

    /// The confirmation an ``VoiceSessionControlAction/approveRequest`` or
    /// ``VoiceSessionControlAction/denyRequest`` press is answering, taken
    /// from the `ContentState` the button was drawn from; `""` on every other
    /// action.
    ///
    /// It travels because the island cannot be trusted to be current, and a
    /// decision is the one command where that matters: the web layer answers
    /// this request or drops the press, so a button drawn against a prompt
    /// that has since been decided cannot approve the next one to arrive. See
    /// ``VoiceSessionControlAction/approveRequest``.
    @Parameter(title: "Request")
    var requestId: String

    init() {}

    init(action: VoiceSessionControlAction, requestId: String = "") {
        self.action = action
        self.requestId = requestId
    }

    /// Hand the action to the running session and return.
    ///
    /// Returns without waiting for anything to happen, like the voice deep
    /// links do: App Intents run under a short execution budget, and the
    /// visible result of the command — the island repainting with the new mute
    /// state, or disappearing when the call ends — arrives through the mirror's
    /// own `update` / `end`, not from here.
    ///
    /// **Nothing is applied optimistically to the activity.** It would be one
    /// line to flip `muted` in the content state here and make the button feel
    /// instant, and it would make the island the second writer of a state it
    /// does not own. The web layer is the only thing that knows whether the
    /// mute actually took, so it stays the only thing that says so; a button
    /// that lies about a call is worse than one that takes a moment.
    ///
    /// The body compiles out of the VoiceActivity extension, which defines
    /// `VOICE_ACTIVITY_EXTENSION` — same arrangement as
    /// ``VoiceModeDeepLink/route(prompt:)``, and for the same reason: the
    /// router reaches the Capacitor plugin, and the appex does not link
    /// Capacitor. iOS performs this in the app process regardless of which
    /// process's UI the tap came from.
    @MainActor
    func perform() async throws -> some IntentResult {
        #if VOICE_ACTIVITY_EXTENSION
        assertionFailure("Voice session controls are performed in the app process, not the appex")
        #else
        VoiceLiveActivityPlugin.deliverControl(action, requestId: requestId)
        #endif
        return .result()
    }
}
