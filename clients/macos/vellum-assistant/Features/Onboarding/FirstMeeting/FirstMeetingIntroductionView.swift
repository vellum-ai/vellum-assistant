import SwiftUI
import VellumAssistantShared

@MainActor
struct FirstMeetingIntroductionView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    let onComplete: () -> Void

    @State private var viewModel: FirstMeetingIntroductionViewModel
    @State private var showControls = false
    @State private var streamingMessageId = UUID()
    @State private var hasCompleted = false

    init(state: OnboardingState, daemonClient: DaemonClientProtocol, onComplete: @escaping () -> Void) {
        self.state = state
        self.daemonClient = daemonClient
        self.onComplete = onComplete
        self._viewModel = State(initialValue: FirstMeetingIntroductionViewModel(
            daemonClient: daemonClient
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
            // Main content: evolving avatar left, chat panel right
            HStack(alignment: .center, spacing: VSpacing.xxxl) {
                // Evolving avatar — shows progressive visual changes during conversation
                EvolvingAvatarView(evolutionState: state.avatarEvolutionState, animated: false)
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
                    completeConversation()
                } label: {
                    Text("Skip for now")
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
            // Ensure hatched milestone is applied so the avatar is visible
            DeterministicEvolutionEngine.applyMilestone(.hatched, to: state.avatarEvolutionState)
            viewModel.startConversation()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showControls = true
                }
            }
        }
        .onChange(of: viewModel.turnCount) { _, newTurnCount in
            applyConversationMilestones(turnCount: newTurnCount)
        }
        .onChange(of: viewModel.isFinished) {
            if viewModel.isFinished {
                completeConversation()
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
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 24, height: 24)
                    .background(
                        Circle()
                            .fill(sendButtonDisabled ? VColor.textMuted : VColor.sendButton)
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

    // MARK: - Milestone Detection

    /// Apply evolution milestones based on conversation progress.
    /// Uses turn count as a proxy for conversation phases:
    /// - Turn 2+: name likely discussed -> nameChosen
    /// - Turn 4+: personality emerging -> personalityDefined
    /// - Turn 6+: emoji/identity solidifying -> emojiChosen
    private func applyConversationMilestones(turnCount: Int) {
        let evo = state.avatarEvolutionState
        if turnCount >= 2 {
            DeterministicEvolutionEngine.applyMilestone(
                .nameChosen,
                to: evo,
                context: MilestoneContext(assistantName: state.assistantName)
            )
        }
        if turnCount >= 4 {
            // Gather personality text from assistant messages
            let personalityText = viewModel.messages
                .filter { $0.role == .assistant }
                .map(\.text)
                .joined(separator: " ")
            DeterministicEvolutionEngine.applyMilestone(
                .personalityDefined,
                to: evo,
                context: MilestoneContext(personalityText: personalityText)
            )
        }
        if turnCount >= 6 {
            let emoji = IdentityInfo.load()?.emoji
            DeterministicEvolutionEngine.applyMilestone(
                .emojiChosen,
                to: evo,
                context: MilestoneContext(emoji: emoji)
            )
        }

        // Resolve updated traits into appearance so EvolvingAvatarView picks up changes
        let resolved = AvatarEvolutionResolver.resolve(state: evo)
        AvatarAppearanceManager.shared.applyEvolutionResult(resolved)
    }

    // MARK: - Conversation Completion

    private func completeConversation() {
        guard !hasCompleted else { return }
        hasCompleted = true

        // Extract conversation data (name, first task candidate).
        viewModel.extractConversationData()

        // Save extracted data to state.
        if let name = viewModel.extractedName, !name.isEmpty {
            state.assistantName = name
        }
        if let task = viewModel.extractedFirstTask {
            state.firstTaskCandidate = task
        }

        state.conversationCompleted = true
        viewModel.endConversation()

        onComplete()
    }
}

#Preview {
    ZStack {
        MeadowBackground()
        FirstMeetingIntroductionView(
            state: {
                let s = OnboardingState()
                s.currentStep = 2
                s.onboardingVariant = .firstMeeting
                return s
            }(),
            daemonClient: DaemonClient(),
            onComplete: {}
        )
    }
    .frame(width: 1366, height: 849)
}
