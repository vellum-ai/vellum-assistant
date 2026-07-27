import AppIntents

/// "New voice conversation" — always start a clean live-voice session, never
/// rejoin one in progress.
///
/// The Action Button target: a physical button press should do the same thing
/// every time. See `StartVoiceModeIntent` for why this is a second intent
/// rather than a `mode` parameter, and for the launch-mode declaration below.
///
/// Lives in `Shared/` — compiled into the app *and* the VoiceActivity
/// extension — rather than beside its sibling in `Intents/`, because
/// `StartVoiceControl` builds a `ControlWidgetButton` around this exact type
/// and a control is code in the appex. Sharing one type is what makes the
/// Control Center control, the Action Button and Siri the same action rather
/// than three lookalikes. The launch-mode declaration below is what keeps that
/// safe: the system performs the intent in the app process, so the appex's
/// copy of `perform()` never runs.
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
