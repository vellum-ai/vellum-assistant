import SwiftUI
import VellumAssistantShared

/// Standalone view for the error toast overlay, creating a SwiftUI
/// invalidation boundary so changes to unrelated `@ObservedObject`s on
/// `MainWindowView` don't force this overlay to re-evaluate.
///
/// Accepts the active view model directly, keeping the dependency surface minimal.
struct MainWindowErrorOverlay: View {
    let activeViewModel: ChatViewModel?

    var body: some View {
        Group {
            if let viewModel = activeViewModel {
                ErrorToastOverlay(
                    errorManager: viewModel.errorManager,
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
