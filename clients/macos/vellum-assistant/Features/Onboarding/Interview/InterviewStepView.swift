import SwiftUI

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

    /// Show the "ready" button once we have at least one assistant message.
    private var hasAssistantMessage: Bool {
        viewModel.messages.contains { $0.role == .assistant }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Title area
            VStack(spacing: VSpacing.xs) {
                Text("Meet \(state.assistantName.isEmpty ? "your assistant" : state.assistantName)")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("Say hi \u{2014} it\u{2019}ll only take a minute")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
            }
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.md)

            // Chat area
            InterviewChatView(
                messages: displayedMessages,
                inputText: $viewModel.inputText,
                isThinking: viewModel.isThinking,
                onSend: { viewModel.sendMessage() },
                onVoiceToggle: {},
                isRecording: false
            )
            .frame(maxHeight: .infinity)
            .allowsHitTesting(!viewModel.isFinished)

            // Bottom controls
            VStack(spacing: VSpacing.md) {
                if hasAssistantMessage && showControls {
                    OnboardingButton(
                        title: viewModel.isFinished ? "Let\u{2019}s get started!" : "I\u{2019}m ready to go!",
                        style: .primary
                    ) {
                        state.interviewCompleted = true
                        viewModel.endInterview()
                        onComplete()
                    }
                    .scaleEffect(viewModel.isFinished ? 1.05 : 1.0)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: viewModel.isFinished)
                }

                if !viewModel.isFinished {
                    Button {
                        viewModel.endInterview()
                        onComplete()
                    } label: {
                        Text("I\u{2019}m good, let\u{2019}s go")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering in
                        NSCursor.pointingHand.set()
                        if !hovering { NSCursor.arrow.set() }
                    }
                }
            }
            .padding(.vertical, VSpacing.lg)
        }
        .onAppear {
            viewModel.startInterview()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showControls = true
                }
            }
        }
        .onDisappear {
            viewModel.cancel()
        }
    }
}

#Preview {
    ZStack {
        MeadowBackground()
        InterviewStepView(
            state: {
                let s = OnboardingState()
                s.currentStep = 7
                s.assistantName = "Velly"
                return s
            }(),
            daemonClient: DaemonClient(),
            onComplete: {}
        )
        .frame(width: 520, height: 600)
    }
    .frame(width: 1366, height: 849)
}
