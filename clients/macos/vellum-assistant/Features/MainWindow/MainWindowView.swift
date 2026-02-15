import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var zoomManager: ZoomManager
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var windowState: MainWindowState
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var selectedThreadId: UUID?
    @State private var workspaceEditorContentHeight: CGFloat = 20
    @State private var showSharePicker = false
    @AppStorage("useThreadDrawer") private var useThreadDrawer: Bool = true
    @AppStorage("sidePanelWidth") private var sidePanelWidth: Double = 400
    let daemonClient: DaemonClient
    let surfaceManager: SurfaceManager
    let ambientAgent: AmbientAgent
    let settingsStore: SettingsStore
    let onMicrophoneToggle: () -> Void

    init(threadManager: ThreadManager, zoomManager: ZoomManager, traceStore: TraceStore, daemonClient: DaemonClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, settingsStore: SettingsStore, windowState: MainWindowState, onMicrophoneToggle: @escaping () -> Void = {}) {
        self.threadManager = threadManager
        self.zoomManager = zoomManager
        self.traceStore = traceStore
        self.daemonClient = daemonClient
        self.surfaceManager = surfaceManager
        self.ambientAgent = ambientAgent
        self.settingsStore = settingsStore
        self.windowState = windowState
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
                                    VIconButton(label: "Dynamic", icon: "wand.and.stars", isActive: windowState.activePanel == .generated, iconOnly: true) {
                                        windowState.togglePanel(.generated)
                                    }
                                    VIconButton(label: "Skills", icon: "exclamationmark.triangle", isActive: windowState.activePanel == .agent, iconOnly: true) {
                                        windowState.togglePanel(.agent)
                                    }
                                    VIconButton(label: "Settings", icon: "gearshape", isActive: windowState.activePanel == .settings, iconOnly: true) {
                                        windowState.togglePanel(.settings)
                                    }
                                    VIconButton(label: "Directory", icon: "doc.text", isActive: windowState.activePanel == .directory, iconOnly: true) {
                                        windowState.togglePanel(.directory)
                                    }
                                    VIconButton(label: "Debug", icon: "ant", isActive: windowState.activePanel == .debug, iconOnly: true) {
                                        windowState.togglePanel(.debug)
                                    }
                                    VIconButton(label: "Doctor", icon: "stethoscope", isActive: windowState.activePanel == .doctor, iconOnly: true) {
                                        windowState.togglePanel(.doctor)
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
                            activePanel: $windowState.activePanel
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
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
            selectedThreadId = threadManager.activeThreadId
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
        }
        .onReceive(daemonClient.$isConnected) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
        }
        .onChange(of: windowState.activePanel) { _, newPanel in
            // Reset expanded state and active surface when navigating away from the
            // Dynamic panel via toolbar or tab bar buttons, which only modify activePanel.
            if newPanel != .generated {
                showSharePicker = false
                windowState.isDynamicExpanded = false
                windowState.activeDynamicSurface = nil
                windowState.activeDynamicParsedSurface = nil
            }
        }
        .onChange(of: selectedThreadId) { _, newId in
            if let newId = newId {
                threadManager.selectThread(id: newId)
            }
        }
        .onChange(of: threadManager.activeThreadId) { oldId, newId in
            // Sync activeThreadId changes back to selectedThreadId to keep sidebar selection in sync
            selectedThreadId = newId
            // Clear stale activeSurfaceId on the old thread and sync the new one
            if let oldId {
                threadManager.clearActiveSurface(threadId: oldId)
            }
            threadManager.activeViewModel?.activeSurfaceId = windowState.isDynamicExpanded ? windowState.activeDynamicSurface?.surfaceId : nil
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDynamicWorkspace)) { notification in
            if let msg = notification.userInfo?["surfaceMessage"] as? UiSurfaceShowMessage {
                windowState.activeDynamicSurface = msg
                windowState.activeDynamicParsedSurface = Surface.from(msg)
                windowState.activePanel = .generated
                windowState.isDynamicExpanded = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .updateDynamicWorkspace)) { notification in
            if let updated = notification.userInfo?["surface"] as? Surface,
               updated.id == windowState.activeDynamicSurface?.surfaceId {
                windowState.activeDynamicParsedSurface = updated
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dismissDynamicWorkspace)) { notification in
            // If a specific surfaceId was dismissed, only clear if it matches.
            if let surfaceId = notification.userInfo?["surfaceId"] as? String {
                if windowState.activeDynamicSurface?.surfaceId == surfaceId {
                    showSharePicker = false
                    if windowState.activePanel == .generated {
                        windowState.activePanel = nil
                    }
                    windowState.isDynamicExpanded = false
                    windowState.activeDynamicSurface = nil
                    windowState.activeDynamicParsedSurface = nil
                }
            } else {
                // Bulk dismiss (dismissAll)
                showSharePicker = false
                if windowState.activePanel == .generated {
                    windowState.activePanel = nil
                }
                windowState.isDynamicExpanded = false
                windowState.activeDynamicSurface = nil
                windowState.activeDynamicParsedSurface = nil
            }
        }
        .onChange(of: windowState.isDynamicExpanded) { _, expanded in
            threadManager.activeViewModel?.activeSurfaceId = expanded ? windowState.activeDynamicSurface?.surfaceId : nil
        }
        .onChange(of: windowState.activeDynamicSurface?.surfaceId) { _, surfaceId in
            if windowState.isDynamicExpanded {
                threadManager.activeViewModel?.activeSurfaceId = surfaceId
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
        if windowState.isDynamicExpanded && windowState.activePanel == .generated {
            if let surface = windowState.activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data {
                // Workspace mode: full-window dynamic page
                dynamicWorkspaceView(surface: surface, data: dpData)
            } else {
                // Gallery mode: existing behavior, with workspace routing
                GeneratedPanel(
                    onClose: { showSharePicker = false; windowState.closeDynamicPanel() },
                    isExpanded: $windowState.isDynamicExpanded,
                    daemonClient: daemonClient,
                    onOpenApp: { surfaceMsg in
                        windowState.activeDynamicSurface = surfaceMsg
                        windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                    }
                )
            }
        } else {
            VSplitView(panelWidth: $sidePanelWidth, showPanel: windowState.activePanel != nil, main: {
                if let viewModel = threadManager.activeViewModel {
                    ChatView(
                        messages: viewModel.messages,
                        inputText: Binding(
                            get: { viewModel.inputText },
                            set: { viewModel.inputText = $0 }
                        ),
                        hasAPIKey: windowState.hasAPIKey,
                        isThinking: viewModel.isThinking,
                        isSending: viewModel.isSending,
                        errorText: viewModel.errorText,
                        pendingQueuedCount: viewModel.pendingQueuedCount,
                        suggestion: viewModel.suggestion,
                        pendingAttachments: viewModel.pendingAttachments,
                        isRecording: viewModel.isRecording,
                        onOpenSettings: {
                            // Always provide an immediate, visible fallback.
                            windowState.activePanel = .settings
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

    // MARK: - Dynamic Workspace

    /// Height reserved at the bottom so HTML content scrolls past the floating composer.
    private var workspaceComposerReservedHeight: CGFloat {
        let editorClamped = min(max(workspaceEditorContentHeight, 14), 200)
        let contentHeight = max(editorClamped, 28)
        let expanded = windowState.workspaceComposerExpanded
        let topPad: CGFloat = expanded ? VSpacing.lg : VSpacing.sm
        let buttonRow: CGFloat = expanded ? 28 + VSpacing.xs : 0
        return VSpacing.md + 18 + topPad + VSpacing.sm + contentHeight + buttonRow
    }

    @ViewBuilder
    private func dynamicWorkspaceView(surface: Surface, data: DynamicPageSurfaceData) -> some View {
        ZStack {
            // Full-bleed WebView with CSS content insets
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
                } : nil,
                topContentInset: 56,
                bottomContentInset: workspaceComposerReservedHeight
            )

            // Floating overlays
            VStack(spacing: 0) {
                // Top bar: back button + share button
                HStack {
                    // "< Chat" pill button — single exit action
                    Button(action: {
                        showSharePicker = false
                        windowState.closeDynamicPanel()
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Chat")
                                .font(VFont.bodyMedium)
                        }
                        .foregroundColor(VColor.textPrimary)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(
                            Capsule()
                                .fill(VColor.surface.opacity(0.85))
                                .overlay(Capsule().stroke(VColor.surfaceBorder, lineWidth: 1))
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back to chat")

                    Spacer()

                    // Share button — floating circle, only when appId + page URL exist
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
                                .foregroundColor(VColor.textPrimary)
                                .frame(width: 32, height: 32)
                                .background(
                                    Circle()
                                        .fill(VColor.surface.opacity(0.85))
                                        .overlay(Circle().stroke(VColor.surfaceBorder, lineWidth: 1))
                                )
                        }
                        .menuStyle(.borderlessButton)
                        .frame(width: 32)
                        .accessibilityLabel("Share")
                        .background(
                            ShareSheetButton(
                                items: [shareURL],
                                isPresented: $showSharePicker
                            )
                            .frame(width: 1, height: 1)
                        )
                    }
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.top, VSpacing.md)

                Spacer()

                // Floating composer — fade is handled inside the WebView via CSS
                if let viewModel = threadManager.activeViewModel {
                    ComposerView(
                        inputText: Binding(
                            get: { viewModel.inputText },
                            set: { viewModel.inputText = $0 }
                        ),
                        hasAPIKey: windowState.hasAPIKey,
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
                        editorContentHeight: $workspaceEditorContentHeight,
                        isComposerExpanded: $windowState.workspaceComposerExpanded
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var panelContent: some View {
        if let panel = windowState.activePanel {
            switch panel {
            case .generated:
                GeneratedPanel(onClose: { showSharePicker = false; windowState.closeDynamicPanel() }, isExpanded: $windowState.isDynamicExpanded, daemonClient: daemonClient)
            case .agent:
                AgentPanel(onClose: { windowState.activePanel = nil }, onInvokeSkill: { skill in
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
                SettingsPanel(onClose: { windowState.activePanel = nil }, store: settingsStore, daemonClient: daemonClient)
            case .directory:
                DirectoryPanel(onClose: { windowState.activePanel = nil })
            case .debug:
                DebugPanel(
                    traceStore: traceStore,
                    activeSessionId: threadManager.activeViewModel?.sessionId,
                    onClose: { windowState.activePanel = nil }
                )
            case .doctor:
                DoctorPanel(onClose: { windowState.activePanel = nil })
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
    let agent = AmbientAgent()
    MainWindowView(threadManager: ThreadManager(daemonClient: dc), zoomManager: ZoomManager(), traceStore: TraceStore(), daemonClient: dc, surfaceManager: SurfaceManager(), ambientAgent: agent, settingsStore: SettingsStore(ambientAgent: agent, daemonClient: dc), windowState: MainWindowState())
        .frame(width: 900, height: 600)
        .padding(.top, 36)
}
