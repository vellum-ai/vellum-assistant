import SwiftUI

struct InterviewStepView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    let onComplete: () -> Void

    @State private var viewModel: InterviewViewModel
    @State private var showControls = false
    @State private var streamingMessageId = UUID()
    @State private var isRecording = false

    @State private var voiceInputManager = VoiceInputManager()
    private let profileExtractor: ProfileExtractor

    init(state: OnboardingState, daemonClient: DaemonClientProtocol, onComplete: @escaping () -> Void) {
        self.state = state
        self.daemonClient = daemonClient
        self.onComplete = onComplete
        self._viewModel = State(initialValue: InterviewViewModel(
            daemonClient: daemonClient,
            assistantName: state.assistantName
        ))
        self.profileExtractor = ProfileExtractor(daemonClient: daemonClient)
    }

    /// Combines finalized messages with any in-progress streaming text.
    private var displayedMessages: [InterviewMessage] {
        var msgs = viewModel.messages
        if !viewModel.streamingText.isEmpty {
            msgs.append(InterviewMessage(id: streamingMessageId, role: .assistant, text: viewModel.streamingText))
        }
        return msgs
    }

    /// Show the "ready" button once we have at least 2 complete assistant exchanges.
    private var hasEnoughExchanges: Bool {
        viewModel.messages.filter { $0.role == .assistant }.count >= 2
    }

    /// Show the skip link once the first assistant greeting has fully completed.
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
                onVoiceToggle: { toggleVoice() },
                isRecording: isRecording,
                isStreaming: !viewModel.streamingText.isEmpty,
                onChipTap: { chip in
                    viewModel.inputText = chip
                    viewModel.sendMessage()
                }
            )
            .frame(maxHeight: .infinity)
            .allowsHitTesting(!viewModel.isFinished)

            // Bottom controls
            VStack(spacing: VSpacing.md) {
                if hasEnoughExchanges && showControls {
                    OnboardingButton(
                        title: viewModel.isFinished ? "Let\u{2019}s get started!" : "I\u{2019}m ready to go!",
                        style: .primary
                    ) {
                        completeInterview()
                    }
                    .scaleEffect(viewModel.isFinished ? 1.05 : 1.0)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: viewModel.isFinished)
                }

                if !viewModel.isFinished && hasAssistantMessage {
                    Button {
                        completeInterview()
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
            setupVoiceCallbacks()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showControls = true
                }
            }
        }
        .onDisappear {
            voiceInputManager.stop()
            viewModel.cancel()
        }
    }

    // MARK: - Interview Completion

    /// Ends the interview, triggers background profile extraction, and advances onboarding.
    /// Extraction runs async in the background and does not block onboarding completion.
    private func completeInterview() {
        let messages = viewModel.messages
        let assistantName = state.assistantName

        state.interviewCompleted = true
        viewModel.endInterview()

        // Fire-and-forget background extraction — failures are logged but don't affect onboarding.
        Task { @MainActor in
            await profileExtractor.extractProfile(from: messages, assistantName: assistantName)
        }

        onComplete()
    }

    // MARK: - Voice Input

    private func setupVoiceCallbacks() {
        voiceInputManager.onTranscription = { text in
            viewModel.inputText = text
            viewModel.sendMessage()
        }
        voiceInputManager.onPartialTranscription = { text in
            viewModel.inputText = text
        }
        voiceInputManager.onRecordingStateChanged = { recording in
            isRecording = recording
        }
    }

    private func toggleVoice() {
        voiceInputManager.toggleRecording()
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
