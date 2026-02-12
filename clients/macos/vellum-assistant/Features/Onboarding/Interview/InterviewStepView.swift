import SwiftUI

struct InterviewStepView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    let onComplete: () -> Void

    @State private var viewModel: InterviewViewModel
    @State private var showControls = false
    @State private var streamingMessageId = UUID()
    @State private var isRecording = false
    @State private var headerCollapsed = false
    @State private var floatOffset: CGFloat = 0

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

    private var displayName: String {
        state.assistantName.isEmpty ? "your assistant" : state.assistantName
    }

    var body: some View {
        VStack(spacing: 0) {
            // Title area — collapses after first user message
            header

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
                        title: "Let\u{2019}s get started \u{2192}",
                        style: .primary
                    ) {
                        completeInterview()
                    }
                    .transition(.opacity)
                }

                if !viewModel.isFinished && showControls {
                    Button {
                        completeInterview()
                    } label: {
                        Text("Skip setup for now")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering in
                        NSCursor.pointingHand.set()
                        if !hovering { NSCursor.arrow.set() }
                    }
                    .transition(.opacity)
                }
            }
            .padding(.vertical, VSpacing.lg)
            .animation(.easeOut(duration: 0.5), value: hasEnoughExchanges)
        }
        .onChange(of: displayedMessages.count) {
            let hasUserMessage = displayedMessages.contains { $0.role == .user }
            if hasUserMessage && !headerCollapsed {
                withAnimation(.easeInOut(duration: 0.4)) {
                    headerCollapsed = true
                }
            }
        }
        .onAppear {
            viewModel.startInterview()
            setupVoiceCallbacks()
            // Gentle floating animation for the avatar
            withAnimation(.easeInOut(duration: 2.5).repeatForever(autoreverses: true)) {
                floatOffset = -6
            }
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

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        if headerCollapsed {
            // Collapsed: just the title, smaller
            Text("Meet \(displayName)")
                .font(Font.custom("Silkscreen-Regular", size: 18))
                .foregroundColor(VColor.textPrimary)
                .padding(.top, VSpacing.lg)
                .padding(.bottom, VSpacing.sm)
        } else {
            // Expanded: avatar + title + subtitle + divider
            VStack(spacing: VSpacing.xs) {
                headerAvatar
                    .offset(y: floatOffset)

                Text("Meet \(displayName)")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("Say hi \u{2014} it\u{2019}ll only take a minute")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)

                Divider()
                    .background(VColor.surfaceBorder.opacity(0.3))
                    .padding(.horizontal, VSpacing.xl)
            }
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.md)
        }
    }

    @ViewBuilder
    private var headerAvatar: some View {
        if let url = Bundle.module.url(forResource: "dino", withExtension: "webp"),
           let nsImage = NSImage(contentsOf: url) {
            Image(nsImage: nsImage)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 48, height: 48)
        } else {
            Text("\u{1f995}")
                .font(.system(size: 32))
                .frame(width: 48, height: 48)
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
