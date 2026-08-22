import AppIntents

/// "New chat": open Vellum on a fresh draft conversation.
///
/// The action behind the New Chat buttons on the Home Screen widgets. Unlike
/// `OpenVellumIntent`, which lands wherever the user left off, this one asks
/// for a specific destination, so it carries `NewChatDeepLink` rather than
/// just launching the app.
///
/// Lives in `Shared/` for the same reason as `OpenCameraIntent`: a widget
/// builds a `Button(intent:)` around this exact type and a widget is code in
/// the appex, while the launch-mode declarations below make the system perform
/// the intent in the app process.
struct OpenNewChatIntent: AppIntent {
    static var title: LocalizedStringResource = "New chat"
    static var description = IntentDescription(
        "Open Vellum and start a new chat."
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
        NewChatDeepLink.route()
        return .result()
    }
}
