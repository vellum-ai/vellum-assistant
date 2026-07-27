import AppIntents

/// "New voice conversation" — always start a clean live-voice session, never
/// rejoin one in progress.
///
/// The Action Button target: a physical button press should do the same thing
/// every time. See `StartVoiceModeIntent` for why this is a second intent
/// rather than a `mode` parameter, and for the launch-mode declaration below.
struct StartNewVoiceConversationIntent: AppIntent {
    static var title: LocalizedStringResource = "New voice conversation"
    static var description = IntentDescription(
        "Open Vellum and start a brand-new voice conversation."
    )

    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        VoiceModeDeepLink.new.route()
        return .result()
    }
}
