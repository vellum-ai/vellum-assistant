#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Bottom-sheet wrapper around `SettingsView` for compact size classes.
///
/// The former Settings tab is presented as a sheet now that the tab bar has
/// been removed. `SettingsView` already wraps itself in a `NavigationStack`,
/// so this wrapper only supplies sheet chrome: detents and a drag indicator.
/// Dismissal is handled entirely by the system — users swipe the sheet down
/// or tap outside it — so no explicit dismiss button is needed.
///
/// Apple references consulted (2026-04-20):
/// - Human Interface Guidelines — [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
/// - [`presentationDetents(_:)`](https://developer.apple.com/documentation/swiftui/view/presentationdetents(_:)) (iOS 16+)
/// - [`presentationDragIndicator(_:)`](https://developer.apple.com/documentation/swiftui/view/presentationdragindicator(_:))
struct SettingsBottomSheet: View {
    @Bindable var authManager: AuthManager
    @Binding var navigateToConnect: Bool
    var conversationStore: IOSConversationStore

    var body: some View {
        SettingsView(
            authManager: authManager,
            navigateToConnect: $navigateToConnect,
            conversationStore: conversationStore
        )
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}
#endif
