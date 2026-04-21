import SwiftUI
import VellumAssistantShared

/// Standalone view for the error toast overlay, creating a SwiftUI
/// invalidation boundary so changes to unrelated `@ObservedObject`s on
/// `MainWindowView` don't force this overlay to re-evaluate.
///
/// Accepts the active view model and settings store directly, keeping
/// the dependency surface minimal.
struct MainWindowErrorOverlay: View {
    let activeViewModel: ChatViewModel?
    let settingsStore: SettingsStore
    let windowState: MainWindowState

    var body: some View {
        Group {
            if let viewModel = activeViewModel {
                ErrorToastOverlay(
                    errorManager: viewModel.errorManager,
                    onOpenModelsAndServices: {
                        settingsStore.pendingSettingsTab = .modelsAndServices
                        withAnimation(VAnimation.panel) {
                            windowState.selection = .panel(.settings)
                        }
                    },
                    onRetryConversationError: { viewModel.retryAfterConversationError() },
                    onCopyDebugInfo: { viewModel.copyConversationErrorDebugDetails() },
                    onDismissConversationError: { viewModel.dismissConversationError() },
                    onSendAnyway: { viewModel.sendAnyway() },
                    onRetryLastMessage: { viewModel.retryLastMessage() },
                    onDismissError: { viewModel.dismissError() }
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }
}
