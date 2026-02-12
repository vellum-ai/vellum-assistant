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
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    NSCursor.pointingHand.set()
                    if !hovering { NSCursor.arrow.set() }
                }
                .transition(.opacity)
                .padding(.vertical, VSpacing.md)
            }
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
        .onChange(of: viewModel.isFinished) {
            if viewModel.isFinished {
                completeInterview()
            }
        }
        .onDisappear {
            voiceInputManager.stop()
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

            VIconButton(
                label: "Voice",
                icon: "mic.fill",
                isActive: isRecording,
                iconOnly: true,
                action: { toggleVoice() }
            )

            Button(action: {
                if !viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty {
                    viewModel.sendMessage()
                }
            }) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 24, height: 24)
                    .background(
                        Circle()
                            .fill(sendButtonDisabled ? VColor.textMuted : Violet._600)
                    )
            }
            .buttonStyle(.plain)
            .disabled(sendButtonDisabled)
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            VColor.surface.opacity(0.5)
                .overlay(
                    VStack {
                        Divider().background(VColor.surfaceBorder.opacity(0.4))
                        Spacer()
                    }
                )
        )
    }

    // MARK: - Interview Completion

    private func completeInterview() {
        let messages = viewModel.messages
        let assistantName = state.assistantName

        state.interviewCompleted = true
        viewModel.endInterview()

        Task { @MainActor in
            await profileExtractor.extractProfile(from: messages, assistantName: assistantName)
        }

        onComplete()
    }

    // MARK: - Voice Input

    @MainActor private func setupVoiceCallbacks() {
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

    @MainActor private func toggleVoice() {
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
    }
    .frame(width: 1366, height: 849)
}
