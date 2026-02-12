import SwiftUI

struct MainWindowView: View {
    @StateObject private var threadManager: ThreadManager
    @State private var activePanel: SidePanelType?
    let ambientAgent: AmbientAgent

    init(daemonClient: DaemonClient, ambientAgent: AmbientAgent) {
        _threadManager = StateObject(wrappedValue: ThreadManager(daemonClient: daemonClient))
        self.ambientAgent = ambientAgent
    }

    var body: some View {
        VStack(spacing: 0) {
            // Row 1 — thread tab bar
            ThreadTabBar(
                threads: threadManager.threads,
                activeThreadId: threadManager.activeThreadId,
                onSelect: { threadManager.selectThread(id: $0) },
                onClose: { threadManager.closeThread(id: $0) },
                onCreate: { threadManager.createThread() }
            )

            // Row 2 — navigation toolbar
            NavigationToolbar(activePanel: $activePanel)

            // Row 3 — chat content with optional side panel
            ZStack(alignment: .bottom) {
                // Botanical background decoration
                Image("bg", bundle: .module)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .clipped()
                    .allowsHitTesting(false)

                VSplitView(panelWidth: 420, showPanel: activePanel != nil, main: {
                    if let viewModel = threadManager.activeViewModel {
                        ChatView(
                            messages: viewModel.messages,
                            inputText: Binding(
                                get: { viewModel.inputText },
                                set: { viewModel.inputText = $0 }
                            ),
                            isThinking: viewModel.isThinking,
                            isSending: viewModel.isSending,
                            errorText: viewModel.errorText,
                            pendingQueuedCount: viewModel.pendingQueuedCount,
                            onSend: viewModel.sendMessage,
                            onStop: viewModel.stopGenerating,
                            onDismissError: viewModel.dismissError
                        )
                    }
                }, panel: {
                    panelContent
                })
            }
        }
        .background(VColor.background.ignoresSafeArea())
        .frame(minWidth: 800, minHeight: 600)
    }

    @ViewBuilder
    private var panelContent: some View {
        if let panel = activePanel {
            switch panel {
            case .generated:
                GeneratedPanel(onClose: { activePanel = nil })
            case .agent:
                AgentPanel(onClose: { activePanel = nil })
            case .control:
                ControlPanel(onClose: { activePanel = nil }, ambientAgent: ambientAgent)
            case .directory:
                DirectoryPanel(onClose: { activePanel = nil })
            case .debug:
                DebugPanel(onClose: { activePanel = nil })
            case .doctor:
                DoctorPanel(onClose: { activePanel = nil })
            }
        }
    }
}

#Preview {
    MainWindowView(daemonClient: DaemonClient(), ambientAgent: AmbientAgent())
}
