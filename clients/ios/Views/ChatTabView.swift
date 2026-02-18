#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Loaded once at startup; avoids decoding the 2.3MB PNG on every re-render.
// Internal (not private) so ThreadListView in the same module can share it.
let chatBackgroundImage: UIImage? = {
    guard let url = Bundle.main.url(forResource: "background", withExtension: "png") else { return nil }
    return UIImage(contentsOfFile: url.path)
}()

struct ChatTabView: View {
    @StateObject private var viewModel: ChatViewModel
    @FocusState private var isInputFocused: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var emptyStateVisible = false
    @State private var greeting: String = {
        let choices = [
            "What are we working on?",
            "I'm here whenever you need me.",
            "What's on your mind?",
            "Let's make something happen.",
            "Ready when you are.",
        ]
        return choices.randomElement()!
    }()

    init(daemonClient: any DaemonClientProtocol) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages area — empty state when no messages, otherwise scrollable list
            if viewModel.messages.isEmpty && !viewModel.isSending && !viewModel.isThinking {
                emptyStateView
            } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: VSpacing.md) {
                        let messages = viewModel.messages
                        ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                            let isLastAssistant = message.role == .assistant
                                && !message.isStreaming
                                && (index == messages.count - 1
                                    || (index == messages.count - 2
                                        && messages[messages.count - 1].confirmation != nil
                                        && messages[messages.count - 1].confirmation?.state != .pending))
                                && !viewModel.isSending
                                && !viewModel.isThinking
                            MessageBubbleView(
                                message: message,
                                onConfirmationResponse: { requestId, decision in
                                    viewModel.respondToConfirmation(requestId: requestId, decision: decision)
                                },
                                onSurfaceAction: { surfaceId, actionId, data in
                                    viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data)
                                },
                                onRegenerate: isLastAssistant ? { viewModel.regenerateLastMessage() } : nil
                            )
                            .id(message.id)
                        }

                        // Current step indicator shown while generating
                        if viewModel.isSending {
                            let allToolCalls = viewModel.messages.last?.toolCalls ?? []
                            CurrentStepIndicator(
                                toolCalls: allToolCalls,
                                isStreaming: viewModel.isSending,
                                onTap: {}
                            )
                            .padding(.horizontal, VSpacing.lg)
                            .id("step-indicator")
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
                .onChange(of: viewModel.isSending) { _, isSending in
                    if isSending {
                        withAnimation(.easeOut(duration: 0.3)) {
                            proxy.scrollTo("step-indicator", anchor: .bottom)
                        }
                    }
                }
            }
            } // end else (messages non-empty)

            // Session error banner
            if let sessionError = viewModel.sessionError {
                sessionErrorBanner(sessionError)
            } else if let errorText = viewModel.errorText {
                // Generic error banner with optional retry
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.white)
                        .font(VFont.caption)
                    Text(errorText)
                        .font(VFont.caption)
                        .foregroundColor(.white)
                        .lineLimit(2)
                    Spacer()
                    if viewModel.isRetryableError {
                        Button(action: { viewModel.retryLastMessage() }) {
                            Text("Retry")
                                .font(VFont.captionMedium)
                                .foregroundColor(.white)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, VSpacing.xs)
                                .background(Color.white.opacity(0.25))
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        }
                    }
                    Button(action: { viewModel.dismissError() }) {
                        Image(systemName: "xmark")
                            .font(VFont.caption)
                            .foregroundColor(.white)
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.error)
                .transition(.move(edge: .top).combined(with: .opacity))
            }

            // Input bar
            InputBarView(
                text: $viewModel.inputText,
                isInputFocused: $isInputFocused,
                isGenerating: viewModel.isSending || viewModel.isThinking,
                isCancelling: viewModel.isCancelling,
                onSend: viewModel.sendMessage,
                onStop: viewModel.stopGenerating,
                onVoiceResult: { _ in
                    viewModel.pendingVoiceMessage = true
                    viewModel.sendMessage()
                },
                viewModel: viewModel
            )
        }
        .background(alignment: .bottom) { chatBackground }
        .background(VColor.chatBackground)
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
        .animation(.easeInOut(duration: 0.2), value: viewModel.sessionError != nil)
        .animation(.easeInOut(duration: 0.2), value: viewModel.errorText)
        .onChange(of: viewModel.messages.isEmpty) { _, isEmpty in
            if isEmpty {
                greeting = ["What are we working on?", "I'm here whenever you need me.",
                            "What's on your mind?", "Let's make something happen.",
                            "Ready when you are."].randomElement()!
            }
        }
    }

    // MARK: - Session Error Banner

    @ViewBuilder
    private func sessionErrorBanner(_ error: SessionError) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: sessionErrorIcon(error.category))
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(sessionErrorAccent(error.category))

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(error.message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                Text(error.recoverySuggestion)
                    .font(VFont.small)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if error.isRetryable {
                Button(action: { viewModel.retryAfterSessionError() }) {
                    Text("Retry")
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(sessionErrorAccent(error.category))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            }

            Button(action: { viewModel.dismissSessionError() }) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(VColor.textMuted)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(sessionErrorAccent(error.category).opacity(0.1))
        .overlay(
            Rectangle()
                .fill(sessionErrorAccent(error.category))
                .frame(width: 3),
            alignment: .leading
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private func sessionErrorIcon(_ category: SessionErrorCategory) -> String {
        switch category {
        case .providerNetwork:
            return "wifi.exclamationmark"
        case .rateLimit:
            return "clock.badge.exclamationmark"
        case .providerApi:
            return "exclamationmark.icloud.fill"
        case .queueFull:
            return "tray.full.fill"
        case .sessionAborted:
            return "stop.circle.fill"
        case .processingFailed, .regenerateFailed:
            return "arrow.triangle.2.circlepath"
        case .unknown:
            return "exclamationmark.triangle.fill"
        }
    }

    private func sessionErrorAccent(_ category: SessionErrorCategory) -> Color {
        switch category {
        case .rateLimit, .queueFull:
            return VColor.warning
        case .providerNetwork:
            return .orange
        case .sessionAborted:
            return VColor.textSecondary
        default:
            return VColor.error
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            Spacer()
            Image(systemName: "sparkles")
                .font(.system(size: 48, weight: .thin))
                .foregroundColor(VColor.accent)
                .opacity(emptyStateVisible ? 1 : 0)
                .scaleEffect(emptyStateVisible ? 1 : 0.8)
            Text(greeting)
                .font(.system(size: 22, weight: .medium))
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .opacity(emptyStateVisible ? 1 : 0)
                .offset(y: emptyStateVisible ? 0 : 8)
                .padding(.horizontal, VSpacing.xl)
            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    VColor.accent.opacity(0.07),
                    VColor.accent.opacity(0.02),
                    Color.clear,
                ]),
                center: .center,
                startRadius: 20,
                endRadius: 350
            )
            .offset(y: -40)
            .opacity(emptyStateVisible ? 1 : 0)
        )
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                emptyStateVisible = true
            }
        }
        .onDisappear {
            emptyStateVisible = false
        }
    }

    // MARK: - Chat Background

    @ViewBuilder
    private var chatBackground: some View {
        if colorScheme == .dark, let uiImage = chatBackgroundImage {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFit()
                .allowsHitTesting(false)
        }
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
    let daemonClient: any DaemonClientProtocol = DaemonClient(config: .default)
    return NavigationStack {
        ChatTabView(daemonClient: daemonClient)
    }
}
#endif
