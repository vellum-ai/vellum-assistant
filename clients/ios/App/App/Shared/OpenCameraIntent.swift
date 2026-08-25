import AppIntents

/// "Take a photo": open Vellum with the composer's camera already up.
///
/// The action behind the Quick Actions widget's camera button. It hands
/// `CameraDeepLink` to the shell rather than opening anything itself, so the
/// widget, a link typed into Safari, and any future Shortcut converge on the
/// one parser the SPA already has.
///
/// Lives in `Shared/` (compiled into the app *and* the VoiceActivity
/// extension) rather than in `Intents/`, because a widget builds a
/// `Button(intent:)` around this exact type and a widget is code in the appex.
/// The launch-mode declarations below make the system perform the intent in
/// the app process, so the appex's copy of `perform()` never runs.
struct OpenCameraIntent: AppIntent {
    static var title: LocalizedStringResource = "Take a photo"
    static var description = IntentDescription(
        "Open Vellum and take a photo to send to your assistant."
    )

    /// Both launch-mode declarations are load-bearing; do not "clean this up".
    /// `supportedModes` is the current API but is itself iOS 26.0+, while
    /// `openAppWhenRun` is what launches the app on 17.0 through 25.x.
    /// `.foreground(.immediate)` is the documented exact equivalent, so the
    /// two agree. See `docs/NATIVE_VOICE.md` for the full explanation.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        CameraDeepLink.route()
        return .result()
    }
}
