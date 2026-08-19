import AppIntents

/// "Send Message to Chat": send a message into a chosen existing
/// conversation, continuing that conversation's context (LUM-3230).
///
/// The chat comes from `ChatEntity`'s picker (backed by the synced
/// recent-chats cache) and the message is free-form text, so a Shortcuts
/// automation can feed both. The pair rides a `<scheme>://thread/<id>` deep
/// link into the SPA, which navigates to the conversation and sends the
/// message once it has confirmed the conversation still exists (a stale
/// picker entry degrades to a pre-filled composer, nothing sent elsewhere).
///
/// The SPA sends on the intent's behalf only because the shell proves the
/// link came from an intent: `AppDelegate.deliverCommandURL(_:)`, which only
/// in-process intents call, marks the URL, and every externally opened URL
/// has that marker stripped (`CommandURLProvenance`, LUM-3281). The same
/// URL opened from Safari or another app therefore only pre-fills.
///
/// The app must open for that to happen: the web view is the only executor
/// this shell has, so this is a foreground intent, not a background send.
///
/// ## Why this is not in `VoiceAppShortcuts`
///
/// An `AppIntent` in the app bundle appears in the Shortcuts app's action
/// library on its own; `AppShortcutsProvider` registration only adds Siri
/// phrases, Spotlight, and the Action Button. The Shortcuts app is this
/// intent's whole audience (the reporter builds their own shortcut around
/// it), and a useful Siri phrase would have to interpolate the chat entity,
/// which drags in donation and localization concerns that can follow later
/// if anyone asks.
struct SendMessageToChatIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Message to Chat"
    static var description = IntentDescription(
        "Open a chosen Vellum chat and send your message there, continuing that conversation."
    )

    @Parameter(
        title: "Chat",
        requestValueDialog: IntentDialog("Which chat should the message go to?")
    )
    var chat: ChatEntity

    /// Non-optional on purpose, like `AskVellumIntent.request`: an invocation
    /// with no content should make the system ask for it. A blank value that
    /// arrives anyway (Shortcuts can pass one) degrades in `ThreadDeepLink`
    /// to just opening the chat.
    @Parameter(
        title: "Message",
        requestValueDialog: IntentDialog("What should the message say?")
    )
    var message: String

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to \(\.$chat)")
    }

    // Same dual declaration as the voice intents, for the same reason: iOS 26
    // soft-deprecated `openAppWhenRun` in favor of `supportedModes`, but
    // `supportedModes` is iOS 26.0+ and this app deploys to 17.0.
    // `.foreground(.immediate)` is the documented equivalent of
    // `openAppWhenRun = true`. Do not collapse these into one.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        ThreadDeepLink(threadId: chat.id).route(message: message)
        return .result()
    }
}
