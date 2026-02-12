import SwiftUI

struct MainWindowView: View {
    @StateObject private var threadManager: ThreadManager

    init(daemonClient: DaemonClient) {
        _threadManager = StateObject(wrappedValue: ThreadManager(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Row 1 — thread bar slot (placeholder)
            Color.clear.frame(height: 36)

            // Row 2 — toolbar slot (placeholder)
            Color.clear.frame(height: 36)

            // Row 3 — chat content bound to active thread
            if let viewModel = threadManager.activeViewModel {
                ChatView(
                    messages: viewModel.messages,
                    inputText: Binding(
                        get: { viewModel.inputText },
                        set: { viewModel.inputText = $0 }
                    ),
                    isThinking: viewModel.isThinking,
                    isSending: viewModel.isSending,
                    errorText: viewModel.errorText,
                    pendingQueuedCount: viewModel.pendingQueuedCount,
                    onSend: viewModel.sendMessage,
                    onStop: viewModel.stopGenerating,
                    onDismissError: viewModel.dismissError
                )
            }
        }
        .background(VColor.background.ignoresSafeArea())
        .frame(minWidth: 800, minHeight: 600)
    }
}

#Preview {
    MainWindowView(daemonClient: DaemonClient())
}
