import SwiftUI

struct MainWindowView: View {
    @StateObject private var viewModel: ChatViewModel

    init(daemonClient: DaemonClient) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        ZStack {
            VColor.background
                .ignoresSafeArea()

            ChatView(
                messages: viewModel.messages,
                inputText: $viewModel.inputText,
                isThinking: viewModel.isThinking,
                isSending: viewModel.isSending,
                errorText: viewModel.errorText,
                onSend: viewModel.sendMessage,
                onDismissError: viewModel.dismissError
            )
        }
        .frame(minWidth: 800, minHeight: 600)
    }
}

#Preview {
    MainWindowView(daemonClient: DaemonClient())
}
