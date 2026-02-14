import SwiftUI
import VellumAssistantShared

struct ChatTabView: View {
    @EnvironmentObject var daemonClient: DaemonClient
    @StateObject private var viewModel: ChatViewModel
    @FocusState private var isInputFocused: Bool

    init(daemonClient: DaemonClient) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages list
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: VSpacing.md) {
                        ForEach(viewModel.messages) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }
                    }
                    .padding(VSpacing.lg)
                }
                .onChange(of: viewModel.messages.count) { _ in
                    scrollToBottom(proxy: proxy)
                }
                .onChange(of: viewModel.messages.last?.text) { _ in
                    scrollToBottom(proxy: proxy)
                }
            }

            // Input bar
            InputBarView(
                text: $viewModel.inputText,
                isInputFocused: $isInputFocused,
                isGenerating: viewModel.isSending || viewModel.isThinking,
                onSend: viewModel.sendMessage
            )
        }
        .background(VColor.background)
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        guard let lastMessage = viewModel.messages.last else { return }
        withAnimation(.easeOut(duration: 0.3)) {
            proxy.scrollTo(lastMessage.id, anchor: .bottom)
        }
    }
}

#Preview {
    NavigationView {
        ChatTabView(daemonClient: DaemonClient(config: .default))
            .environmentObject(DaemonClient(config: .default))
    }
}
