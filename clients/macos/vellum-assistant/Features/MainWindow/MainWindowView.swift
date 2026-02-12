import SwiftUI
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @State private var activePanel: SidePanelType?
    let daemonClient: DaemonClient
    let ambientAgent: AmbientAgent

    init(threadManager: ThreadManager, daemonClient: DaemonClient, ambientAgent: AmbientAgent) {
        self.threadManager = threadManager
        self.daemonClient = daemonClient
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
                        suggestion: viewModel.suggestion,
                        pendingAttachments: viewModel.pendingAttachments,
                        onSend: viewModel.sendMessage,
                        onStop: viewModel.stopGenerating,
                        onDismissError: viewModel.dismissError,
                        onAcceptSuggestion: viewModel.acceptSuggestion,
                        onAttach: { Self.openFilePicker(viewModel: viewModel) },
                        onConfirmationAllow: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "allow") },
                        onConfirmationDeny: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "deny") }
                    )
                }
            }, panel: {
                panelContent
            })
        }
        .ignoresSafeArea(edges: .top)
        .background(VColor.background.ignoresSafeArea())
        .frame(minWidth: 800, minHeight: 600)
    }

    @MainActor
    private static func openFilePicker(viewModel: ChatViewModel) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [
            .png, .jpeg, .gif, .webP, .pdf, .plainText, .commaSeparatedText,
            UTType("net.daringfireball.markdown") ?? .plainText,
        ]
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            viewModel.addAttachment(url: url)
        }
    }

    @ViewBuilder
    private var panelContent: some View {
        if let panel = activePanel {
            switch panel {
            case .generated:
                GeneratedPanel(onClose: { activePanel = nil })
            case .agent:
                AgentPanel(onClose: { activePanel = nil }, daemonClient: daemonClient)
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
    let dc = DaemonClient()
    return MainWindowView(threadManager: ThreadManager(daemonClient: dc), daemonClient: dc, ambientAgent: AmbientAgent())
}
