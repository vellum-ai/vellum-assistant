import SwiftUI

struct InterviewStepView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    let onComplete: () -> Void

    @State private var viewModel: InterviewViewModel
    @State private var showControls = false

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
            msgs.append(InterviewMessage(role: .assistant, text: viewModel.streamingText))
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

                Text("Have a quick chat before you get started")
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

            // Bottom controls
            VStack(spacing: VSpacing.md) {
                if hasAssistantMessage && showControls {
                    OnboardingButton(
                        title: "I\u{2019}m ready to go!",
                        style: .primary
                    ) {
                        state.interviewCompleted = true
                        viewModel.endInterview()
                        onComplete()
                    }
                }

                Button {
                    viewModel.endInterview()
                    onComplete()
                } label: {
                    Text("Skip")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    NSCursor.pointingHand.set()
                    if !hovering { NSCursor.arrow.set() }
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
