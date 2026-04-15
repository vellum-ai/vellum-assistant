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
                    onSkip: { advanceTo(1) }
                )
            case 1:
                TaskToneSelectionView(
                    selectedTasks: $state.selectedTasks,
                    toneValue: $state.toneValue,
                    onBack: { advanceTo(0) },
                    onContinue: { advanceTo(2) },
                    onSkip: { advanceTo(2) }
                )
            default:
                NameExchangeView(
                    contextSummary: state.contextSummary,
                    userName: $state.userName,
                    assistantName: $state.assistantName,
                    onBack: { advanceTo(1) },
                    onComplete: { finish() },
                    onSkip: { finish() }
                )
            }
        }
        .animation(VAnimation.panel, value: state.currentScreen)
        .transition(.asymmetric(
            insertion: .move(edge: .trailing).combined(with: .opacity),
            removal: .move(edge: .leading).combined(with: .opacity)
        ))
    }

    // MARK: - Navigation

    private func advanceTo(_ screen: Int) {
        withAnimation(VAnimation.panel) {
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

}
