import AppIntents
import Foundation

/// The three things the Live Activity can do to a running voice session: mute
/// the microphone, mute the assistant's audio, and hang up.
///
/// Deliberately the same three the voice room's control row carries
/// (`clients/web/src/domains/chat/voice/voice-room/voice-room.tsx`), in the same
/// order, because the island IS that row when the app is not on screen. It is
/// not a second, smaller feature with controls of its own choosing.
///
/// The two mutes are *toggles*, not "mute" and "unmute": the button's meaning
/// comes from the state it is rendered against, and the island renders from a
/// `ContentState` that may be several seconds stale when the web layer is
/// suspended. A `setMuted(true)` composed natively from that stale view would
/// be the wrong command as often as the state is wrong; a toggle applied by the
/// layer that actually owns the session is right whatever the island was
/// showing.
enum VoiceSessionControlAction: String, AppEnum {
    /// Mute or unmute capture, so the assistant stops or resumes hearing you.
    case toggleMicrophone
    /// Mute or unmute playback, so you stop or resume hearing the assistant.
    /// Its turn keeps running underneath either way.
    case toggleAssistantAudio
    /// End the call.
    case endSession

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        "Voice session control"
    }

    static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
        [
            .toggleMicrophone: "Toggle microphone",
            .toggleAssistantAudio: "Toggle assistant audio",
            .endSession: "End voice session",
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

    init() {}

    init(action: VoiceSessionControlAction) {
        self.action = action
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
        VoiceLiveActivityPlugin.deliverControl(action)
        #endif
        return .result()
    }
}
