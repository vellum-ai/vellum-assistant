import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var zoomManager: ZoomManager
    @ObservedObject var traceStore: TraceStore
    @State private var activePanel: SidePanelType?
    @State private var isDynamicExpanded = false
    @State private var hasAPIKey = APIKeyManager.hasAnyKey()
    let daemonClient: DaemonClient
    let ambientAgent: AmbientAgent
    let onMicrophoneToggle: () -> Void

    init(threadManager: ThreadManager, zoomManager: ZoomManager, traceStore: TraceStore, daemonClient: DaemonClient, ambientAgent: AmbientAgent, onMicrophoneToggle: @escaping () -> Void = {}) {
        self.threadManager = threadManager
        self.zoomManager = zoomManager
        self.traceStore = traceStore
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
                if isDynamicExpanded && activePanel == .generated {
                    GeneratedPanel(
                        onClose: { activePanel = nil; isDynamicExpanded = false },
                        isExpanded: $isDynamicExpanded,
                        daemonClient: daemonClient
                    )
                } else {
                    VSplitView(panelWidth: geometry.size.width / zoomManager.zoomLevel * 0.5, showPanel: activePanel != nil, main: {
                        if let viewModel = threadManager.activeViewModel {
                            ZStack(alignment: .bottom) {
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
                                        activePanel = .settings
                                        Self.openSettings()
                                    },
                                    onSend: viewModel.sendMessage,
                                    onStop: viewModel.stopGenerating,
                                    onDismissError: viewModel.dismissError,
                                    onAcceptSuggestion: viewModel.acceptSuggestion,
                                    onAttach: { Self.openFilePicker(viewModel: viewModel) },
                                    onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
                                    onDropFiles: { urls in urls.forEach { viewModel.addAttachment(url: $0) } },
                                    onDropImageData: { data, name in
                                        let filename: String
                                        if let name {
                                            let basename = (name as NSString).lastPathComponent
                                            let base = (basename as NSString).deletingPathExtension
                                            filename = base.isEmpty ? "Dropped Image.png" : "\(base).png"
                                        } else {
                                            filename = "Dropped Image.png"
                                        }
                                        viewModel.addAttachment(imageData: data, filename: filename)
                                    },
                                    onPaste: { viewModel.addAttachmentFromPasteboard() },
                                    onMicrophoneToggle: onMicrophoneToggle,
                                    onConfirmationAllow: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "allow") },
                                    onConfirmationDeny: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "deny") },
                                    onAddTrustRule: { toolName, pattern, scope, decision in return viewModel.addTrustRule(toolName: toolName, pattern: pattern, scope: scope, decision: decision) },
                                    onSurfaceAction: { surfaceId, actionId, data in viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data) },
                                    onRegenerate: { viewModel.regenerateLastMessage() }
                                )

                                sessionErrorToast(viewModel: viewModel)
                            }
                            .animation(VAnimation.standard, value: viewModel.sessionError != nil)
                        }
                    }, panel: {
                        panelContent
                    })
                }
            }
            .ignoresSafeArea(edges: .top)
            .background(VColor.background.ignoresSafeArea())
            .frame(width: geometry.size.width / zoomManager.zoomLevel,
                   height: geometry.size.height / zoomManager.zoomLevel)
            .scaleEffect(zoomManager.zoomLevel, anchor: .topLeading)
            .frame(width: geometry.size.width, height: geometry.size.height,
                   alignment: .topLeading)
        }
        .frame(minWidth: 800, minHeight: 600)
        .overlay(alignment: .top) {
            if zoomManager.showZoomIndicator {
                ZoomIndicatorView(percentage: zoomManager.zoomPercentage)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .padding(.top, VSpacing.xxl + VSpacing.xl)
            }
        }
        .animation(VAnimation.fast, value: zoomManager.showZoomIndicator)
        .onAppear {
            refreshAPIKeyState()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            refreshAPIKeyState()
        }
        .onReceive(daemonClient.$isConnected) { _ in
            refreshAPIKeyState()
        }
        .onChange(of: activePanel) { _, newPanel in
            // Reset expanded state when navigating away from the Dynamic panel
            // via toolbar or tab bar buttons, which only modify activePanel.
            if newPanel != .generated {
                isDynamicExpanded = false
            }
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
        hasAPIKey = APIKeyManager.hasAnyKey() || daemonClient.isConnected
    }

    @ViewBuilder
    private func sessionErrorToast(viewModel: ChatViewModel) -> some View {
        if let error = viewModel.sessionError {
            VToast(
                message: error.message,
                style: .error,
                primaryAction: error.isRetryable ? VToastAction(label: "Retry") {
                    viewModel.retryAfterSessionError()
                } : nil,
                secondaryAction: VToastAction(label: "Copy Debug Info") {
                    viewModel.copySessionErrorDebugDetails()
                },
                onDismiss: {
                    viewModel.dismissSessionError()
                }
            )
            .padding(.horizontal, VSpacing.xl)
            .padding(.bottom, 100)
            .frame(maxWidth: 700)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var panelContent: some View {
        if let panel = activePanel {
            switch panel {
            case .generated:
                GeneratedPanel(onClose: { activePanel = nil; isDynamicExpanded = false }, isExpanded: $isDynamicExpanded, daemonClient: daemonClient)
            case .agent:
                AgentPanel(onClose: { activePanel = nil }, onInvokeSkill: { skill in
                    if threadManager.activeViewModel == nil {
                        threadManager.createThread()
                    }
                    if let viewModel = threadManager.activeViewModel {
                        viewModel.pendingSkillInvocation = SkillInvocationData(
                            name: skill.name,
                            emoji: skill.emoji,
                            description: skill.description
                        )
                        viewModel.inputText = "Use the \(skill.name) skill"
                        viewModel.sendMessage()
                        // Clear leaked metadata if sendMessage() returned early
                        viewModel.pendingSkillInvocation = nil
                    }
                }, daemonClient: daemonClient)
            case .settings:
                SettingsPanel(onClose: { activePanel = nil }, ambientAgent: ambientAgent, daemonClient: daemonClient)
            case .directory:
                DirectoryPanel(onClose: { activePanel = nil })
            case .debug:
                DebugPanel(
                    traceStore: traceStore,
                    activeSessionId: threadManager.activeViewModel?.sessionId,
                    onClose: { activePanel = nil }
                )
            case .doctor:
                DoctorPanel(onClose: { activePanel = nil })
            }
        }
    }
}

private struct ZoomIndicatorView: View {
    let percentage: Int

    var body: some View {
        Text("\(percentage)%")
            .font(VFont.bodyMedium)
            .foregroundStyle(VColor.textPrimary)
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
    }
}

#Preview {
    let dc = DaemonClient()
    return MainWindowView(threadManager: ThreadManager(daemonClient: dc), zoomManager: ZoomManager(), traceStore: TraceStore(), daemonClient: dc, ambientAgent: AmbientAgent())
        .frame(width: 900, height: 600)
        .padding(.top, 36)
}
