import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var zoomManager: ZoomManager
    @ObservedObject var traceStore: TraceStore
    @State private var activePanel: SidePanelType?
    @State private var isDynamicExpanded = false
    @State private var activeDynamicSurface: UiSurfaceShowMessage?
    /// Parsed surface for the active workspace dynamic page, kept in sync with
    /// SurfaceManager via notifications so updates from the daemon are reflected.
    @State private var activeDynamicParsedSurface: Surface?
    @State private var hasAPIKey = APIKeyManager.hasAnyKey()
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var selectedThreadId: UUID?
    @State private var workspaceEditorContentHeight: CGFloat = 20
    @State private var showSharePicker = false
    @AppStorage("useThreadDrawer") private var useThreadDrawer: Bool = true
    @AppStorage("sidePanelWidth") private var sidePanelWidth: Double = 400
    let daemonClient: DaemonClient
    let surfaceManager: SurfaceManager
    let ambientAgent: AmbientAgent
    let onMicrophoneToggle: () -> Void

    init(threadManager: ThreadManager, zoomManager: ZoomManager, traceStore: TraceStore, daemonClient: DaemonClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, onMicrophoneToggle: @escaping () -> Void = {}) {
        self.threadManager = threadManager
        self.zoomManager = zoomManager
        self.traceStore = traceStore
        self.daemonClient = daemonClient
        self.surfaceManager = surfaceManager
        self.ambientAgent = ambientAgent
        self.onMicrophoneToggle = onMicrophoneToggle
    }

    // MARK: - Layout Constants

    /// Leading padding to account for macOS traffic light buttons (red/yellow/green).
    /// Note: This is a fixed value that may not be accurate for all window styles or
    /// if Apple changes the traffic light spacing. Dynamic measurement would be better
    /// but requires complex window geometry inspection.
    private let trafficLightPadding: CGFloat = 78

    private func pageURL(for appId: String) -> URL? {
        guard let port = daemonClient.httpPort else { return nil }
        return URL(string: "http://localhost:\(port)/pages/\(appId)")
    }

    var body: some View {
        GeometryReader { geometry in
            Group {
                if useThreadDrawer {
                    // Drawer mode: Custom split view (no NavigationSplitView)
                    VStack(spacing: 0) {
                        // Button bar (matches ThreadTabBar height and style)
                        VStack(spacing: 0) {
                            HStack(spacing: 0) {
                                // Thread drawer toggle
                                VIconButton(label: "Threads", icon: "list.bullet", isActive: columnVisibility != .detailOnly, iconOnly: true) {
                                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                        columnVisibility = (columnVisibility == .detailOnly) ? .all : .detailOnly
                                    }
                                }

                                Spacer()

                                // Panel toggle buttons
                                HStack(spacing: VSpacing.sm) {
                                    VIconButton(label: "Dynamic", icon: "wand.and.stars", isActive: activePanel == .generated, iconOnly: true) {
                                        togglePanel(.generated)
                                    }
                                    VIconButton(label: "Skills", icon: "exclamationmark.triangle", isActive: activePanel == .agent, iconOnly: true) {
                                        togglePanel(.agent)
                                    }
                                    VIconButton(label: "Settings", icon: "gearshape", isActive: activePanel == .settings, iconOnly: true) {
                                        togglePanel(.settings)
                                    }
                                    VIconButton(label: "Directory", icon: "doc.text", isActive: activePanel == .directory, iconOnly: true) {
                                        togglePanel(.directory)
                                    }
                                    VIconButton(label: "Debug", icon: "ant", isActive: activePanel == .debug, iconOnly: true) {
                                        togglePanel(.debug)
                                    }
                                    VIconButton(label: "Doctor", icon: "stethoscope", isActive: activePanel == .doctor, iconOnly: true) {
                                        togglePanel(.doctor)
                                    }
                                }
                            }
                            .padding(.leading, trafficLightPadding)
                            .padding(.trailing, VSpacing.lg)
                            .frame(height: 36)
                            .background(VColor.background)
                        }

                        // Content area with left drawer + chat + right panel
                        HStack(spacing: 0) {
                            // Left: Thread drawer (conditional)
                            if columnVisibility != .detailOnly {
                                threadDrawerView
                                    .transition(.move(edge: .leading))
                            }

                            // Center: Chat + right panel
                            chatContentView(geometry: geometry)
                        }
                        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: columnVisibility)
                    }
                } else {
                    // Tab mode: Traditional layout
                    VStack(spacing: 0) {
                        // Row 1 — thread tab bar
                        ThreadTabBar(
                            threads: threadManager.threads,
                            activeThreadId: threadManager.activeThreadId,
                            onSelect: { threadManager.selectThread(id: $0) },
                            onClose: { threadManager.closeThread(id: $0) },
                            onCreate: { threadManager.createThread() },
                            activePanel: $activePanel
                        )

                        // Row 2 — chat content with optional side panel
                        chatContentView(geometry: geometry)
                    }
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
            selectedThreadId = threadManager.activeThreadId
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            refreshAPIKeyState()
        }
        .onReceive(daemonClient.$isConnected) { _ in
            refreshAPIKeyState()
        }
        .onChange(of: activePanel) { _, newPanel in
            // Reset expanded state and active surface when navigating away from the
            // Dynamic panel via toolbar or tab bar buttons, which only modify activePanel.
            if newPanel != .generated {
                showSharePicker = false
                isDynamicExpanded = false
                activeDynamicSurface = nil
                activeDynamicParsedSurface = nil
            }
        }
        .onChange(of: selectedThreadId) { _, newId in
            if let newId = newId {
                threadManager.selectThread(id: newId)
            }
        }
        .onChange(of: threadManager.activeThreadId) { _, newId in
            // Sync activeThreadId changes back to selectedThreadId to keep sidebar selection in sync
            selectedThreadId = newId
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDynamicWorkspace)) { notification in
            if let msg = notification.userInfo?["surfaceMessage"] as? UiSurfaceShowMessage {
                activeDynamicSurface = msg
                activeDynamicParsedSurface = Surface.from(msg)
                activePanel = .generated
                isDynamicExpanded = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .updateDynamicWorkspace)) { notification in
            if let updated = notification.userInfo?["surface"] as? Surface,
               updated.id == activeDynamicSurface?.surfaceId {
                activeDynamicParsedSurface = updated
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dismissDynamicWorkspace)) { notification in
            // If a specific surfaceId was dismissed, only clear if it matches.
            if let surfaceId = notification.userInfo?["surfaceId"] as? String {
                if activeDynamicSurface?.surfaceId == surfaceId {
                    showSharePicker = false
                    if activePanel == .generated {
                        activePanel = nil
                    }
                    isDynamicExpanded = false
                    activeDynamicSurface = nil
                    activeDynamicParsedSurface = nil
                }
            } else {
                // Bulk dismiss (dismissAll)
                showSharePicker = false
                if activePanel == .generated {
                    activePanel = nil
                }
                isDynamicExpanded = false
                activeDynamicSurface = nil
                activeDynamicParsedSurface = nil
            }
        }
    }

    @ViewBuilder
    private func threadItem(_ thread: ThreadModel) -> some View {
        Button(action: { threadManager.selectThread(id: thread.id) }) {
            HStack(spacing: VSpacing.sm) {
                Text(thread.title)
                    .font(VFont.body)
                    .foregroundColor(thread.id == threadManager.activeThreadId ? VColor.accent : VColor.textPrimary)
                Spacer()
                // Reserve space for close button
                if threadManager.threads.count > 1 {
                    Spacer().frame(width: 16)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            if threadManager.threads.count > 1 {
                Button(action: { threadManager.closeThread(id: thread.id) }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 16, height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close \(thread.title)")
                .padding(.trailing, VSpacing.lg)
            }
        }
        .background(thread.id == threadManager.activeThreadId ? VColor.surface : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    @ViewBuilder
    private var threadDrawerView: some View {
        VStack(spacing: 0) {
            HStack {
                Text("THREADS")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                VIconButton(label: "New Thread", icon: "plus", iconOnly: true) {
                    threadManager.createThread()
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.lg)
            .padding(.bottom, VSpacing.xs)

            ScrollView {
                VStack(spacing: VSpacing.xs) {
                    ForEach(threadManager.threads) { thread in
                        threadItem(thread)
                    }
                }
                .padding(.horizontal, VSpacing.sm)
            }

            // Switch to tabs button
            Button(action: {
                useThreadDrawer = false
            }) {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "rectangle.3.group")
                        .font(.system(size: 11))
                    Text("Switch to tabs")
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                if hovering {
                    NSCursor.pointingHand.set()
                } else {
                    NSCursor.arrow.set()
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.bottom, VSpacing.md)
        }
        .frame(width: 240)
        .background(VColor.backgroundSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .padding(.bottom, VSpacing.sm)
        .padding(.leading, VSpacing.sm)
    }

    @ViewBuilder
    private func chatContentView(geometry: GeometryProxy) -> some View {
        if isDynamicExpanded && activePanel == .generated {
            if let surface = activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data {
                // Workspace mode: full-window dynamic page
                dynamicWorkspaceView(surface: surface, data: dpData)
            } else {
                // Gallery mode: existing behavior, with workspace routing
                GeneratedPanel(
                    onClose: { activePanel = nil; isDynamicExpanded = false; activeDynamicSurface = nil; activeDynamicParsedSurface = nil },
                    isExpanded: $isDynamicExpanded,
                    daemonClient: daemonClient,
                    onOpenApp: { surfaceMsg in
                        activeDynamicSurface = surfaceMsg
                        activeDynamicParsedSurface = Surface.from(surfaceMsg)
                    }
                )
            }
        } else {
            VSplitView(panelWidth: $sidePanelWidth, showPanel: activePanel != nil, main: {
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
                        onRegenerate: { viewModel.regenerateLastMessage() },
                        sessionError: viewModel.sessionError,
                        onRetry: { viewModel.retryAfterSessionError() },
                        onDismissSessionError: { viewModel.dismissSessionError() },
                        onCopyDebugInfo: { viewModel.copySessionErrorDebugDetails() }
                    )
                }
            }, panel: {
                panelContent
            })
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

    private func togglePanel(_ panel: SidePanelType) {
        if activePanel == panel {
            activePanel = nil
        } else {
            activePanel = panel
        }
    }

    // MARK: - Dynamic Workspace

    @ViewBuilder
    private func dynamicWorkspaceView(surface: Surface, data: DynamicPageSurfaceData) -> some View {
        VStack(spacing: 0) {
            // Toolbar
            HStack {
                Button(action: { showSharePicker = false; activeDynamicSurface = nil; activeDynamicParsedSurface = nil }) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to gallery")

                Text(surface.title ?? "App")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)

                Spacer()

                // Share button — only shown when the runtime page server is active
                if let appId = data.appId, let shareURL = pageURL(for: appId) {
                    Menu {
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(shareURL.absoluteString, forType: .string)
                        } label: {
                            Label("Copy Link", systemImage: "doc.on.doc")
                        }
                        Button {
                            showSharePicker = true
                        } label: {
                            Label("Share\u{2026}", systemImage: "square.and.arrow.up")
                        }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textMuted)
                            .frame(width: 28, height: 28)
                    }
                    .menuStyle(.borderlessButton)
                    .frame(width: 28)
                    .accessibilityLabel("Share")
                    .background(
                        ShareSheetButton(
                            items: [shareURL],
                            isPresented: $showSharePicker
                        )
                        .frame(width: 1, height: 1)
                    )
                }

                Button(action: { showSharePicker = false; activePanel = nil; isDynamicExpanded = false; activeDynamicSurface = nil; activeDynamicParsedSurface = nil }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close workspace")
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.lg)

            Divider().background(VColor.surfaceBorder)

            // Dynamic page WebView fills remaining space
            DynamicPageSurfaceView(
                data: data,
                onAction: { actionId, actionData in
                    surfaceManager.onAction?(surface.sessionId, surface.id, actionId, actionData as? [String: Any])
                },
                appId: data.appId,
                onDataRequest: data.appId != nil ? { callId, method, recordId, requestData in
                    guard let appId = surfaceManager.surfaceAppIds[surface.id] else { return }
                    surfaceManager.onDataRequest?(surface.id, callId, method, appId, recordId, requestData)
                } : nil,
                onCoordinatorReady: data.appId != nil ? { coordinator in
                    surfaceManager.surfaceCoordinators[surface.id] = coordinator
                } : nil
            )

            // Chatbar pinned at bottom
            if let viewModel = threadManager.activeViewModel {
                ComposerView(
                    inputText: Binding(
                        get: { viewModel.inputText },
                        set: { viewModel.inputText = $0 }
                    ),
                    hasAPIKey: hasAPIKey,
                    isSending: viewModel.isSending,
                    isRecording: viewModel.isRecording,
                    suggestion: viewModel.suggestion,
                    pendingAttachments: viewModel.pendingAttachments,
                    onSend: viewModel.sendMessage,
                    onStop: viewModel.stopGenerating,
                    onAcceptSuggestion: viewModel.acceptSuggestion,
                    onAttach: { Self.openFilePicker(viewModel: viewModel) },
                    onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
                    onPaste: { viewModel.addAttachmentFromPasteboard() },
                    onMicrophoneToggle: onMicrophoneToggle,
                    editorContentHeight: $workspaceEditorContentHeight
                )
            }
        }
        .background(VColor.backgroundSubtle)
    }

    @ViewBuilder
    private var panelContent: some View {
        if let panel = activePanel {
            switch panel {
            case .generated:
                GeneratedPanel(onClose: { activePanel = nil; isDynamicExpanded = false; activeDynamicSurface = nil; activeDynamicParsedSurface = nil }, isExpanded: $isDynamicExpanded, daemonClient: daemonClient)
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
    return MainWindowView(threadManager: ThreadManager(daemonClient: dc), zoomManager: ZoomManager(), traceStore: TraceStore(), daemonClient: dc, surfaceManager: SurfaceManager(), ambientAgent: AmbientAgent())
        .frame(width: 900, height: 600)
        .padding(.top, 36)
}
