import AppIntents

/// "Open Vellum": bring the app to the foreground, nothing more.
///
/// The action behind `OpenVellumControl`, the one-tap app launcher in Control
/// Center and the Lock Screen. It deliberately carries no deep link: opening
/// the app lands wherever the user left it, exactly as tapping the home-screen
/// icon does, so there is no second launch destination to keep in sync with
/// the web layer.
///
/// Lives in `Shared/` (compiled into the app *and* the VoiceActivity
/// extension) rather than in `Intents/`, because `OpenVellumControl` builds a
/// `ControlWidgetButton` around this exact type and a control is code in the
/// appex. The launch-mode declarations below make the system perform the
/// intent in the app process, so the appex's copy of `perform()` never runs.
struct OpenVellumIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Vellum"
    static var description = IntentDescription(
        "Open Vellum and pick up where you left off."
    )

    /// Both launch-mode declarations are load-bearing; do not "clean this up".
    /// `supportedModes` is the current API but is itself iOS 26.0+, while
    /// `openAppWhenRun` is what launches the app on 17.0 through 25.x.
    /// `.foreground(.immediate)` is the documented exact equivalent, so the
    /// two agree. See `docs/NATIVE_VOICE.md` for the full explanation.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    static var openAppWhenRun: Bool { true }

    func perform() async throws -> some IntentResult {
        return .result()
    }
}
