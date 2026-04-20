#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Bottom-sheet wrapper around `SettingsView` for compact size classes.
///
/// The former Settings tab is presented as a sheet now that the tab bar has
/// been removed. `SettingsView` already wraps itself in a `NavigationStack`,
/// so this wrapper only supplies sheet chrome: detents, a drag indicator, and
/// a dismiss button at the leading edge of the nav bar for users who prefer
/// taps over drags.
///
/// Apple references consulted (2026-04-20):
/// - Human Interface Guidelines — [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
/// - [`presentationDetents(_:)`](https://developer.apple.com/documentation/swiftui/view/presentationdetents(_:)) (iOS 16+)
/// - [`presentationDragIndicator(_:)`](https://developer.apple.com/documentation/swiftui/view/presentationdragindicator(_:))
struct SettingsBottomSheet: View {
    @Environment(\.dismiss) private var dismiss
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
