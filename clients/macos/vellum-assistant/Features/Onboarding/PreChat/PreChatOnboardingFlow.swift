import SwiftUI
import VellumAssistantShared

/// Container view that sequences the three pre-chat onboarding screens
/// (tool selection → task/tone → name exchange) with slide transitions.
///
/// Calls `onComplete` with a populated `PreChatOnboardingContext` when the
/// user finishes the flow, or `nil` when the user skips everything.
@MainActor
struct PreChatOnboardingFlow: View {
    @State private var state: PreChatOnboardingState
    let onComplete: (PreChatOnboardingContext?) -> Void

    init(initialAssistantName: String? = nil, onComplete: @escaping (PreChatOnboardingContext?) -> Void) {
        let s = PreChatOnboardingState()
        if let name = initialAssistantName, !name.isEmpty {
            s.assistantName = name
        }
        self._state = State(initialValue: s)
        self.onComplete = onComplete
    }

    var body: some View {
        Group {
            switch state.currentScreen {
            case 0:
                ToolSelectionView(
                    selectedTools: $state.selectedTools,
                    onContinue: { advanceTo(1) },
                    onSkip: { skipAll() }
                )
            case 1:
                VStack(spacing: 0) {
                    backButton { advanceTo(0) }
                    TaskToneSelectionView(
                        selectedTasks: $state.selectedTasks,
                        toneValue: $state.toneValue,
                        onContinue: { advanceTo(2) },
                        onSkip: { skipAll() }
                    )
                }
            default:
                VStack(spacing: 0) {
                    backButton { advanceTo(1) }
                    NameExchangeView(
                        contextSummary: state.contextSummary,
                        userName: $state.userName,
                        assistantName: $state.assistantName,
                        onComplete: { finish() },
                        onSkip: { skipAll() }
                    )
                }
            }
        }
        .animation(.spring(duration: 0.5, bounce: 0.1), value: state.currentScreen)
        .transition(.asymmetric(
            insertion: .move(edge: .trailing).combined(with: .opacity),
            removal: .move(edge: .leading).combined(with: .opacity)
        ))
    }

    // MARK: - Back Button

    @ViewBuilder
    private func backButton(action: @escaping () -> Void) -> some View {
        HStack {
            Button {
                action()
            } label: {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.chevronLeft, size: 12)
                    Text("Back")
                        .font(VFont.bodyMediumDefault)
                }
                .foregroundStyle(VColor.contentSecondary)
            }
            .buttonStyle(.plain)
            Spacer()
        }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg, bottom: 0, trailing: VSpacing.lg))
    }

    // MARK: - Navigation

    private func advanceTo(_ screen: Int) {
        withAnimation(.spring(duration: 0.5, bounce: 0.1)) {
            state.currentScreen = screen
        }
        state.persist()
    }

    // MARK: - Completion

    private func finish() {
        let context = PreChatOnboardingContext(
            tools: Array(state.selectedTools).sorted(),
            tasks: Array(state.selectedTasks).sorted(),
            tone: state.toneLabel,
            userName: state.userName.isEmpty ? nil : state.userName,
            assistantName: state.assistantName.isEmpty ? nil : state.assistantName
        )
        PreChatOnboardingState.clearPersistedState()
        onComplete(context)
    }

    private func skipAll() {
        PreChatOnboardingState.clearPersistedState()
        onComplete(nil)
    }
}
