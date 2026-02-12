import SwiftUI

struct MainWindowView: View {
    @StateObject private var threadManager: ThreadManager
    @State private var activePanel: SidePanelType?

    init(daemonClient: DaemonClient) {
        _threadManager = StateObject(wrappedValue: ThreadManager(daemonClient: daemonClient))
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
        .background(VColor.background.ignoresSafeArea())
        .frame(minWidth: 800, minHeight: 600)
    }

    @ViewBuilder
    private var panelContent: some View {
        if let panel = activePanel {
            switch panel {
            case .generated:
                placeholderPanel("Generated", icon: "wand.and.stars")
            case .agent:
                placeholderPanel("Agent", icon: "exclamationmark.triangle")
            case .control:
                placeholderPanel("Control", icon: "gearshape")
            case .directory:
                placeholderPanel("Directory", icon: "doc.text")
            case .debug:
                placeholderPanel("Debug", icon: "ant")
            case .doctor:
                placeholderPanel("Doctor", icon: "stethoscope")
            }
        }
    }

    private func placeholderPanel(_ title: String, icon: String) -> some View {
        VSidePanel(title: title, onClose: { activePanel = nil }) {
            VEmptyState(
                title: "Coming soon",
                subtitle: "\(title) panel content will appear here",
                icon: icon
            )
        }
    }
}

#Preview {
    MainWindowView(daemonClient: DaemonClient())
}
