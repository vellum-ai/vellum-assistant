import AppIntents

/// "Ask a question" — Siri collects the *content* of the request before the app
/// is up, then hands it over with the voice session.
///
/// The difference from `StartVoiceModeIntent` / `StartNewVoiceConversationIntent`
/// is where the first turn comes from. Those two open the app into voice mode
/// and leave the user to speak once they are there. This one takes the question
/// as a parameter, so "ask Vellum what's on my calendar" carries the question
/// with it and the app opens with it already in hand.
///
/// The question rides the existing `<scheme>://voice` contract as a `prompt`
/// query parameter (see `VoiceModeDeepLink`), not a second command channel:
/// one URL shape, one parser, one place where an untrusted value is bounded.
///
/// ## Why the phrases carry no parameter
///
/// App Shortcut phrases can interpolate a parameter only when its type conforms
/// to `AppEnum` or `AppEntity` — a free-form `String` cannot appear in one. So
/// the registered phrases end at the app name, and Siri collects the question in
/// a follow-up turn driven by `requestValueDialog` below. That is also exactly
/// what should happen for a bare "Hey Siri, ask Vellum": the parameter is
/// non-optional, so Siri prompts rather than launching into an empty session.
struct AskVellumIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask a question"
    static var description = IntentDescription(
        "Open Vellum and start a voice conversation with your question already asked."
    )

    /// What the user wants to ask. Non-optional on purpose: an invocation with
    /// no content should make Siri ask for it, and a `String?` would instead
    /// resolve to `nil` and start a silent session.
    @Parameter(
        title: "Request",
        requestValueDialog: IntentDialog("What should I ask Vellum?")
    )
    var request: String

    // Same dual declaration as the launch intents, for the same reason: iOS 26
    // soft-deprecated `openAppWhenRun` in favor of `supportedModes`, but
    // `supportedModes` is iOS 26.0+ and this app deploys to 17.0.
    // `.foreground(.immediate)` is the documented equivalent of
    // `openAppWhenRun = true`. Do not collapse these into one.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        // Always `new`: a question is a fresh ask, and rejoining a call in
        // progress would drop it into the middle of someone else's turn.
        VoiceModeDeepLink.new.route(prompt: request)
        return .result()
    }
}
