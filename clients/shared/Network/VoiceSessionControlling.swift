import Foundation

/// Session-level controls shared across every live voice control surface —
/// in-app UI, a platform control surface such as an iOS Live Activity or
/// Dynamic Island, or a future spoken-command dispatcher.
///
/// This is intentionally decoupled from any concrete session's state machine
/// (e.g. `LiveVoiceChannelManager.State` on macOS) so a control surface can
/// mute the microphone, mute assistant speech, or end the session without
/// depending on a platform-specific manager type. Any live voice session
/// manager, on any platform, should conform to this protocol so new control
/// surfaces can be written once against `VoiceSessionControlling` instead of
/// against each platform's concrete manager.
@MainActor
public protocol VoiceSessionControlling: AnyObject {
    /// True when the local microphone is muted. The session may still be
    /// connected and capturing input amplitude for UI, but no audio is sent
    /// upstream while muted.
    var isMicrophoneMuted: Bool { get }

    /// True when assistant speech playback is muted locally. The assistant
    /// may still be producing a response while muted; audio simply is not
    /// played back to the user.
    var isAssistantOutputMuted: Bool { get }

    /// Mute or unmute the local microphone without ending the session.
    func setMicrophoneMuted(_ muted: Bool)

    /// Mute or unmute assistant speech playback without ending the session.
    func setAssistantOutputMuted(_ muted: Bool)

    /// End the voice session gracefully.
    func end() async
}
