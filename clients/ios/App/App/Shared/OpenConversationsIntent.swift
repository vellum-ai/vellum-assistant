import AppIntents

/// "Open conversations": open Vellum on the list of conversations.
///
/// The action behind the unread chip on the Quick Actions widget and the
/// unread line on the Status widget. Like `OpenNewChatIntent` it asks for a
/// specific destination rather than landing wherever the user left off, so it
/// carries `ConversationsDeepLink`.
///
/// Lives in `Shared/` for the same reason as `OpenNewChatIntent`: a widget
/// builds a `Button(intent:)` around this exact type and a widget is code in
/// the appex, while the launch-mode declarations below make the system perform
/// the intent in the app process.
struct OpenConversationsIntent: AppIntent {
    static var title: LocalizedStringResource = "Open conversations"
    static var description = IntentDescription(
        "Open Vellum and show the list of conversations."
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
        ConversationsDeepLink.route()
        return .result()
    }
}
