import AppIntents

/// "Start voice mode" — bring the user into a live-voice conversation, joining
/// one already in flight when there is one.
///
/// Paired with `StartNewVoiceConversationIntent`, which always starts fresh.
/// Two intents rather than one intent with a `mode` parameter because the
/// Action Button picker in Settings binds a shortcut, not a shortcut plus an
/// argument — a parameterized intent would leave that binding ambiguous. This
/// one is the natural Siri target ("talk to Vellum" should rejoin a call in
/// progress); the other is the natural Action Button target.
///
/// `VoiceAppShortcuts` carries both intents into Siri, Spotlight, and the
/// Action Button picker; add any new phrase there rather than here.
struct StartVoiceModeIntent: AppIntent {
    static var title: LocalizedStringResource = "Start voice mode"
    static var description = IntentDescription(
        "Open Vellum and start talking, picking up a voice conversation already in progress."
    )

    // iOS 26 soft-deprecated `openAppWhenRun` in favor of `supportedModes`, but
    // `supportedModes` is itself iOS 26.0+ while this app deploys to 17.0 — so
    // both are declared, and `.foreground(.immediate)` is the documented exact
    // equivalent of `openAppWhenRun = true`. Neither `OpenIntent` (which needs a
    // `target` AppEntity and SwiftUI's `onAppIntentExecution`) nor the iOS 26
    // snippet intents fit: there is no entity to open, and the whole point is to
    // launch rather than render a result in place.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        VoiceModeDeepLink.resume.route()
        return .result()
    }
}
