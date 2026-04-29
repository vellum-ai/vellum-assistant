import SwiftUI
import VellumAssistantShared

/// Container view that sequences the three pre-chat onboarding screens
/// (tool selection → task/tone → name exchange) with slide transitions.
///
/// Calls `onComplete` with a populated `PreChatOnboardingContext` when the
/// user finishes or skips through the flow. Skipping individual screens
/// advances to the next screen; the final screen always calls `finish()`
/// so downstream consumers receive a context with sensible defaults.
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
                    onBack: { advanceTo(0) },
                    onContinue: { advanceTo(2) },
                    onSkip: { advanceTo(2) }
                )
            default:
                NameExchangeView(
                    userName: $state.userName,
                    assistantName: $state.assistantName,
                    selectedGroupID: $state.selectedGroupID,
                    displayedAssistantNames: state.displayedAssistantNames,
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
        // Strip internal "other:" prefix so backend receives clean tool names
        let cleanTools = Array(Set(state.selectedTools.map { id in
            id.hasPrefix("other:") ? String(id.dropFirst(6)) : id
        })).sorted()
        let context = PreChatOnboardingContext(
            tools: cleanTools,
            tasks: Array(state.selectedTasks).sorted(),
            tone: state.selectedGroupID ?? PersonalityGroup.defaultGroupID,
            userName: state.userName.isEmpty ? nil : state.userName,
            assistantName: state.assistantName.isEmpty ? nil : state.assistantName
        )
        PreChatOnboardingState.clearPersistedState()
        onComplete(context)
    }

}
