import SwiftUI
import VellumAssistantShared

@MainActor
struct InterviewStepView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    let onComplete: () -> Void

    @State private var viewModel: InterviewViewModel
    @State private var showControls = false
    @State private var streamingMessageId = UUID()

    init(state: OnboardingState, daemonClient: DaemonClientProtocol, onComplete: @escaping () -> Void) {
        self.state = state
        self.daemonClient = daemonClient
        self.onComplete = onComplete
        self._viewModel = State(initialValue: InterviewViewModel(
            daemonClient: daemonClient,
            assistantName: state.assistantName
        ))
    }

    /// Combines finalized messages with any in-progress streaming text.
    private var displayedMessages: [InterviewMessage] {
        var msgs = viewModel.messages
        if !viewModel.streamingText.isEmpty {
            msgs.append(InterviewMessage(id: streamingMessageId, role: .assistant, text: viewModel.streamingText))
        }
        return msgs
    }

    private var sendButtonDisabled: Bool {
        viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Main content: dino left, chat panel right
            HStack(alignment: .center, spacing: VSpacing.xxxl) {
                // Hatched dinosaur — same visual size as in hatch scene
                CreatureView(visible: true, animated: false)
                    .scaleEffect(0.5)
                    .frame(width: 200, height: 200)

                // Chat messages + input in panel
                OnboardingPanel {
                    VStack(spacing: 0) {
                        InterviewChatView(
                            messages: displayedMessages,
                            inputText: viewModel.inputText,
                            isThinking: viewModel.isThinking,
                            isStreaming: !viewModel.streamingText.isEmpty,
                            onChipTap: { chip in
                                viewModel.inputText = chip
                                viewModel.sendMessage()
                            }
                        )
                        .allowsHitTesting(!viewModel.isFinished)

                        inputArea
                    }
                }
                .frame(maxWidth: 520, maxHeight: 560)
            }
            .frame(maxHeight: .infinity)
            .padding(.horizontal, VSpacing.xxxl)

            // Skip link
            if !viewModel.isFinished && showControls {
                Button {
                    completeInterview()
                } label: {
                    Text("Skip setup for now")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .transition(.opacity)
                .padding(.vertical, VSpacing.md)
            }

            OnboardingFooter(currentStep: state.currentStep)
                .padding(.bottom, VSpacing.lg)
        }
        .onAppear {
            viewModel.startInterview()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showControls = true
                }
            }
        }
        .onChange(of: viewModel.isFinished) {
            if viewModel.isFinished {
                completeInterview()
            }
        }
        .onDisappear {
            viewModel.cancel()
        }
    }

    // MARK: - Input Area

    private var inputArea: some View {
        HStack(spacing: VSpacing.sm) {
            VTextField(
                placeholder: "Type a message\u{2026}",
                text: $viewModel.inputText,
                onSubmit: {
                    if !viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty {
                        viewModel.sendMessage()
                    }
                }
            )

            Button(action: {
                if !viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty {
                    viewModel.sendMessage()
                }
            }) {
                VIconView(.arrowUp, size: 12)
                    .foregroundColor(VColor.auxWhite)
                    .frame(width: 24, height: 24)
                    .background(
                        Circle()
                            .fill(sendButtonDisabled ? VColor.contentTertiary : VColor.primaryBase)
                    )
            }
            .buttonStyle(.plain)
            .disabled(sendButtonDisabled)
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            VColor.surfaceBase.opacity(0.5)
                .overlay(
                    VStack {
                        Divider().background(VColor.borderBase.opacity(0.4))
                        Spacer()
                    }
                )
        )
    }

    // MARK: - Interview Completion

    private func completeInterview() {
        state.interviewCompleted = true
        viewModel.endInterview()

        onComplete()
    }
}

#Preview {
    ZStack {
        MeadowBackground()
        InterviewStepView(
            state: {
                let s = OnboardingState()
                s.currentStep = 7
                s.assistantName = "Assistant"
                return s
            }(),
            daemonClient: DaemonClient(),
            onComplete: {}
        )
    }
    .frame(width: 1366, height: 849)
}
