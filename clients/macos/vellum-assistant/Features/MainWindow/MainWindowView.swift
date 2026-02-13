import SwiftUI
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @State private var activePanel: SidePanelType?
    @State private var hasAPIKey = APIKeyManager.getKey() != nil
    let daemonClient: DaemonClient
    let ambientAgent: AmbientAgent
    let onMicrophoneToggle: () -> Void

    init(threadManager: ThreadManager, daemonClient: DaemonClient, ambientAgent: AmbientAgent, onMicrophoneToggle: @escaping () -> Void = {}) {
        self.threadManager = threadManager
        self.daemonClient = daemonClient
        self.ambientAgent = ambientAgent
        self.onMicrophoneToggle = onMicrophoneToggle
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                // Row 1 — thread tab bar + panel buttons
                ThreadTabBar(
                    threads: threadManager.threads,
                    activeThreadId: threadManager.activeThreadId,
                    onSelect: { threadManager.selectThread(id: $0) },
                    onClose: { threadManager.closeThread(id: $0) },
                    onCreate: { threadManager.createThread() },
                    activePanel: $activePanel
                )

                // Row 2 — chat content with optional side panel
                VSplitView(panelWidth: geometry.size.width * 0.5, showPanel: activePanel != nil, main: {
                    if let viewModel = threadManager.activeViewModel {
                        ChatView(
                            messages: viewModel.messages,
                            inputText: Binding(
                                get: { viewModel.inputText },
                                set: { viewModel.inputText = $0 }
                            ),
                            hasAPIKey: hasAPIKey,
                            isThinking: viewModel.isThinking,
                            isSending: viewModel.isSending,
                            errorText: viewModel.errorText,
                            pendingQueuedCount: viewModel.pendingQueuedCount,
                            suggestion: viewModel.suggestion,
                            pendingAttachments: viewModel.pendingAttachments,
                            isRecording: viewModel.isRecording,
                            onOpenSettings: {
                                // Always provide an immediate, visible fallback.
                                activePanel = .control
                                Self.openSettings()
                            },
                            onSend: viewModel.sendMessage,
                            onStop: viewModel.stopGenerating,
                            onDismissError: viewModel.dismissError,
                            onAcceptSuggestion: viewModel.acceptSuggestion,
                            onAttach: { Self.openFilePicker(viewModel: viewModel) },
                            onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
                            onDropFiles: { urls in urls.forEach { viewModel.addAttachment(url: $0) } },
                            onPaste: { viewModel.addAttachmentFromPasteboard() },
                            onMicrophoneToggle: onMicrophoneToggle,
                            onConfirmationAllow: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "allow") },
                            onConfirmationDeny: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "deny") },
                            onAddTrustRule: { toolName, pattern, scope, decision in return viewModel.addTrustRule(toolName: toolName, pattern: pattern, scope: scope, decision: decision) },
                            onSurfaceAction: { surfaceId, actionId, data in viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data) }
                        )
                    }
                }, panel: {
                    panelContent
                })
            }
            .ignoresSafeArea(edges: .top)
            .background(VColor.background.ignoresSafeArea())
        }
        .frame(minWidth: 800, minHeight: 600)
        .onAppear {
            refreshAPIKeyState()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            refreshAPIKeyState()
        }
        .onReceive(daemonClient.$isConnected) { _ in
            refreshAPIKeyState()
        }
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

    @MainActor
    private static func openSettings() {
        NSApp.setActivationPolicy(.regular)

        let selector = Selector(("showSettingsWindow:"))
        if let delegate = NSApp.delegate as? NSObject, delegate.responds(to: selector) {
            _ = delegate.perform(selector, with: nil)
        } else {
            _ = NSApp.sendAction(selector, to: nil, from: nil)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func refreshAPIKeyState() {
        hasAPIKey = APIKeyManager.getKey() != nil || daemonClient.isConnected
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
            case .usage:
                UsagePanel(onClose: { activePanel = nil }, daemonClient: daemonClient)
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
