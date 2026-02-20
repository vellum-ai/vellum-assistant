#if canImport(UIKit)
import AppIntents
import UIKit
import VellumAssistantShared

// MARK: - App Intent

/// Siri Shortcut intent that opens the app and pre-fills the chat input
/// with the user's message. The user confirms by tapping Send.
@available(iOS 16.0, *)
struct SendMessageIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Vellum"
    static var description = IntentDescription("Open Vellum Assistant with a pre-filled message")

    /// Opens the app when the intent runs.
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Message")
    var message: String

    @MainActor
    func perform() async throws -> some IntentResult {
        DeepLinkManager.pendingMessage = message
        return .result()
    }
}

// MARK: - App Shortcuts Provider

/// Makes the "Ask Vellum" shortcut discoverable in the Shortcuts app and via Siri.
@available(iOS 16.0, *)
struct VellumShortcutsProvider: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendMessageIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Open \(.applicationName)"
            ],
            shortTitle: "Ask Vellum",
            systemImageName: "message"
        )
    }
}
#endif
