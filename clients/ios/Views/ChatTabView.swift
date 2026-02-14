import SwiftUI
import VellumAssistantShared

struct ChatTabView: View {
    @StateObject private var viewModel: ChatViewModel
    @FocusState private var isInputFocused: Bool

    init(daemonClient: DaemonClient) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Error banner
            if let errorText = viewModel.errorText {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.error)
                    Text(errorText)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                    Button(action: { viewModel.errorText = nil }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(VColor.textSecondary)
                    }
                }
                .padding(VSpacing.md)
                .background(VColor.error.opacity(0.1))
            }

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
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: viewModel.messages.count) { oldValue, newValue in
                    scrollToBottom(proxy: proxy, animated: true)
                }
                .onChange(of: viewModel.messages.last?.text) { oldValue, newValue in
                    // Scroll without animation during streaming to avoid jank.
                    // Only scroll when actively streaming to avoid overriding the animated
                    // scroll from new message additions (handled by count change above).
                    if viewModel.messages.last?.isStreaming == true {
                        scrollToBottom(proxy: proxy, animated: false)
                    }
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

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool) {
        guard let lastMessage = viewModel.messages.last else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.3)) {
                proxy.scrollTo(lastMessage.id, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(lastMessage.id, anchor: .bottom)
        }
    }
}

#Preview {
    let daemonClient = DaemonClient(config: .default)
    return NavigationStack {
        ChatTabView(daemonClient: daemonClient)
    }
}
