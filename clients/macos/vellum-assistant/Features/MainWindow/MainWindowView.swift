import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    var zoomManager: ZoomManager
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var windowState: MainWindowState
    @State private var selectedThreadId: UUID?
    @State private var workspaceEditorContentHeight: CGFloat = 20
    @State private var showSharePicker = false
    @State private var isBundling = false
    @State private var shareFileURL: URL?
    @State private var isPublishing = false
    @State private var publishedUrl: String?
    @State private var publishError: String?
    @State private var isHoveredThread: UUID?
    @State private var requestedHomeBaseAtLaunch = false

    @AppStorage("useThreadDrawer") private var useThreadDrawer: Bool = true
    @AppStorage("sidebarOpen") private var sidebarOpen: Bool = false
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var systemIsDark: Bool = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    @AppStorage("threadDrawerWidth") private var threadDrawerWidth: Double = 240
    @AppStorage("sidePanelWidth") private var sidePanelWidth: Double = 400
    @AppStorage("homeBaseDashboardDefaultEnabled") private var homeBaseDashboardDefaultEnabled: Bool = true
    @State private var drawerDragStartWidth: Double?
    @State private var drawerDragStartAvailableWidth: CGFloat?
    @State private var isDrawerDragging: Bool = false
    private let drawerDragCoordinateSpaceName = "MainWindowDrawerDragCoordinateSpace"
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

    /// When a generated surface is expanded into the workspace, hide the
    /// global sidebar toggle so workspace controls own the top-left slot.
    private var isGeneratedWorkspaceOpen: Bool {
        windowState.isDynamicExpanded && windowState.activePanel == .generated
    }

    private func pageURL(for appId: String) -> URL? {
        guard let port = daemonClient.httpPort else { return nil }
        return URL(string: "http://localhost:\(port)/pages/\(appId)")
    }

    private func publishPage(html: String, title: String?) {
        guard !isPublishing else { return }
        isPublishing = true
        publishError = nil

        Task { @MainActor in
            daemonClient.onPublishPageResponse = { response in
                isPublishing = false
                if response.success, let url = response.publicUrl {
                    publishedUrl = url
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                } else if let error = response.error, error != "Cancelled" {
                    publishError = error
                    // Auto-dismiss error after 5 seconds
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                        if publishError == error {
                            withAnimation(VAnimation.standard) { publishError = nil }
                        }
                    }
                }
            }

            do {
                try daemonClient.sendPublishPage(html: html, title: title)
            } catch {
                isPublishing = false
            }
        }
    }

    private func bundleAndShare(appId: String) {
        guard !isBundling else { return }
        isBundling = true

        Task { @MainActor in
            daemonClient.onBundleAppResponse = { response in
                self.shareFileURL = URL(fileURLWithPath: response.bundlePath)
                self.isBundling = false
                self.showSharePicker = true
            }

            do {
                try daemonClient.sendBundleApp(appId: appId)
            } catch {
                isBundling = false
            }
        }
    }

    /// Whether the BOOTSTRAP.md first-run ritual is still in progress.
    /// When true, the client shows a chat-only interface — no Home Base dashboard.
    private var isBootstrapOnboardingActive: Bool {
        FileManager.default.fileExists(atPath: NSHomeDirectory() + "/.vellum/workspace/BOOTSTRAP.md")
    }

    private func requestHomeBaseDashboardIfNeeded() {
        guard !isBootstrapOnboardingActive else { return }
        guard homeBaseDashboardDefaultEnabled else { return }
        guard daemonClient.isConnected else { return }
        guard !requestedHomeBaseAtLaunch else { return }
        guard !windowState.isDynamicExpanded else {
            requestedHomeBaseAtLaunch = true
            return
        }

        daemonClient.onHomeBaseGetResponse = { response in
            guard let homeBase = response.homeBase else { return }
            if self.windowState.isDynamicExpanded { return }
            if let activePanel = self.windowState.activePanel, activePanel != .generated {
                return
            }
            try? self.daemonClient.sendAppOpen(appId: homeBase.appId)
        }

        do {
            try daemonClient.sendHomeBaseGet(ensureLinked: true)
            requestedHomeBaseAtLaunch = true
        } catch {
            // Leave false so reconnect can retry.
        }
    }

    var body: some View {
        coreLayoutView
            .onChange(of: windowState.isDynamicExpanded) { _, expanded in
                threadManager.activeViewModel?.activeSurfaceId = expanded ? windowState.activeDynamicSurface?.surfaceId : nil
            }
            .onChange(of: windowState.activeDynamicSurface?.surfaceId) { _, surfaceId in
                if windowState.isDynamicExpanded {
                    threadManager.activeViewModel?.activeSurfaceId = surfaceId
                }
            }
            .onChange(of: threadManager.activeViewModel?.messages.count) { _, _ in
                // Close activity panel if the referenced message no longer exists
                // (e.g., after regenerate, undo, or message rebuild flows)
                if let messageId = windowState.activityMessageId,
                   windowState.activePanel == .activity,
                   let viewModel = threadManager.activeViewModel {
                    let messageExists = viewModel.messages.contains(where: { $0.id == messageId })
                    if !messageExists {
                        windowState.activePanel = nil
                        windowState.activityMessageId = nil
                    }
                }
            }
            .preferredColorScheme(themePreference == "light" ? .light : themePreference == "dark" ? .dark : systemIsDark ? .dark : .light)
            .onReceive(DistributedNotificationCenter.default().publisher(for: Notification.Name("AppleInterfaceThemeChangedNotification"))) { _ in
                systemIsDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            }
    }

    /// Core layout extracted to break up type-checker complexity.
    private var coreLayoutView: some View {
        GeometryReader { geometry in
            Group {
                if useThreadDrawer {
                    // Drawer mode: Full-height sidebar + chat
                    HStack(spacing: 0) {
                        // Left: Full-height sidebar (always rendered, width collapses to 0)
                        threadDrawerView
                            .frame(width: sidebarOpen && windowState.layoutConfig.left.visible ? threadDrawerWidth : 0, alignment: .leading)
                            .clipped()
                            .allowsHitTesting(sidebarOpen && windowState.layoutConfig.left.visible)
                            .animation(isDrawerDragging ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: sidebarOpen)
                            .animation(nil, value: threadDrawerWidth)

                        if sidebarOpen && windowState.layoutConfig.left.visible {
                            drawerDragDivider(availableWidth: geometry.size.width / zoomManager.zoomLevel)
                        }

                        // Right: Chat content
                        chatContentView(geometry: geometry)
                            .padding(.top, !sidebarOpen && windowState.layoutConfig.left.visible && !isGeneratedWorkspaceOpen ? 36 : 0)
                            .overlay(alignment: .topLeading) {
                                // Toggle button when sidebar is hidden
                                if !sidebarOpen && windowState.layoutConfig.left.visible && !isGeneratedWorkspaceOpen {
                                    HStack(spacing: 0) {
                                        VIconButton(label: "Threads", icon: "sidebar.left", isActive: false, iconOnly: true) {
                                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                                sidebarOpen = true
                                            }
                                        }
                                        Spacer()
                                    }
                                    .padding(.leading, trafficLightPadding)
                                    .padding(.trailing, VSpacing.lg)
                                    .frame(height: 36)
                                    .transition(.opacity)
                                }
                            }
                    }
                    .coordinateSpace(name: drawerDragCoordinateSpaceName)
                } else {
                    // Tab mode: Traditional layout
                    VStack(spacing: 0) {
                        // Row 1 — thread tab bar
                        ThreadTabBar(
                            threads: threadManager.visibleThreads,
                            activeThreadId: threadManager.activeThreadId,
                            onSelect: { threadManager.selectThread(id: $0) },
                            onClose: { threadManager.archiveThread(id: $0) },
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
            requestHomeBaseDashboardIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
        }
        .onReceive(daemonClient.$isConnected) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
            requestHomeBaseDashboardIfNeeded()
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
            // Close the activity panel when switching threads — the stored messageId
            // belongs to the previous thread and won't exist in the new one.
            if windowState.activePanel == .activity {
                windowState.activePanel = nil
                windowState.activityMessageId = nil
            }
            // Clear stale activeSurfaceId on the old thread and sync the new one
            if let oldId {
                threadManager.clearActiveSurface(threadId: oldId)
            }
            threadManager.activeViewModel?.activeSurfaceId = windowState.isDynamicExpanded ? windowState.activeDynamicSurface?.surfaceId : nil
        }
        .onChange(of: windowState.activePanel) { _, newPanel in
            // Close the left sidebar when the activity panel opens to avoid crowding
            if newPanel == .activity && sidebarOpen {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    sidebarOpen = false
                }
            }
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
    }

    @ViewBuilder
    private func threadItem(_ thread: ThreadModel) -> some View {
        let isSelected = thread.id == threadManager.activeThreadId
        HStack(spacing: 0) {
            Button(action: {
                threadManager.selectThread(id: thread.id)
                if windowState.activePanel == .directory {
                    windowState.activePanel = nil
                }
            }) {
                Text(thread.title)
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                threadManager.archiveThread(id: thread.id)
            } label: {
                Image(systemName: "archivebox")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(width: 24)
            .opacity(isSelected || isHoveredThread == thread.id ? 1 : 0)
            .allowsHitTesting(isSelected || isHoveredThread == thread.id)
            .accessibilityLabel("Archive \(thread.title)")
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(isSelected || isHoveredThread == thread.id ? VColor.hoverOverlay.opacity(0.08) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .padding(.horizontal, VSpacing.sm)
        .onHover { hovering in
            if hovering {
                isHoveredThread = thread.id
                NSCursor.pointingHand.push()
            } else {
                if isHoveredThread == thread.id {
                    isHoveredThread = nil
                }
                NSCursor.pop()
            }
        }
    }

    @ViewBuilder
    private var threadDrawerView: some View {
        VStack(spacing: 0) {
            // Header with toggle (sits alongside traffic lights)
            HStack(spacing: 0) {
                Spacer()
                VIconButton(label: "Threads", icon: "sidebar.left", isActive: true, iconOnly: true) {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        sidebarOpen = false
                    }
                }
            }
            .padding(.trailing, VSpacing.sm)
            .frame(height: 36)

            NewConversationButton(action: { windowState.activePanel = nil; threadManager.createThread() })
                .padding(.horizontal, VSpacing.sm)
                .padding(.top, VSpacing.md)
                .padding(.bottom, VSpacing.xl)

            Text("Recents")
                .font(.system(size: 11))
                .foregroundColor(VColor.textMuted)
                .padding(.bottom, VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, VSpacing.lg)

            ScrollView {
                VStack(spacing: VSpacing.xs) {
                    ForEach(threadManager.visibleThreads.filter { $0.sessionId != nil || threadManager.threadHasMessages($0.id) }) { thread in
                        threadItem(thread)
                    }
                }
            }
            .scrollClipDisabled()

            Spacer()

            // Control Center
            VColor.surfaceBorder.frame(height: 1)

            ControlCenterMenuButton(
                onSettings: { windowState.togglePanel(.settings) },
                onSkills: { windowState.togglePanel(.agent) },
                onDirectory: { windowState.togglePanel(.directory) },
                onDebug: { windowState.togglePanel(.debug) },
                onDoctor: { windowState.togglePanel(.doctor) }
            )
        }
        .frame(width: threadDrawerWidth)
        .background(VColor.backgroundSubtle)
    }

    private func drawerDragDivider(availableWidth: CGFloat) -> some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: VSpacing.xs)
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.set()
                } else {
                    NSCursor.arrow.set()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .named(drawerDragCoordinateSpaceName))
                    .onChanged { value in
                        // Capture initial state on first drag event
                        if drawerDragStartWidth == nil {
                            drawerDragStartWidth = threadDrawerWidth
                            drawerDragStartAvailableWidth = availableWidth
                            isDrawerDragging = true
                        }

                        guard let initialWidth = drawerDragStartWidth,
                              let initialAvailableWidth = drawerDragStartAvailableWidth else {
                            return
                        }

                        // Use a stable parent coordinate space so divider movement
                        // does not feed back into gesture translation while dragging.
                        let deltaX = value.location.x - value.startLocation.x
                        let newWidth = initialWidth + Double(deltaX)
                        let minMainContent: CGFloat = 300
                        let sidePanelVisible =
                            (windowState.activePanel != nil &&
                             !(windowState.isDynamicExpanded && windowState.activePanel == .generated) &&
                             windowState.activePanel != .directory) ||
                            (windowState.isDynamicExpanded && windowState.activePanel == .generated && windowState.isChatDockOpen)
                        let activePanelWidth: CGFloat = sidePanelVisible ? sidePanelWidth : 0
                        let maxAllowed = initialAvailableWidth - minMainContent - VSpacing.xs - (VSpacing.xs * 2) - activePanelWidth

                        // Update width without animation to prevent jitter
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            threadDrawerWidth = min(max(newWidth, 180), maxAllowed)
                        }
                    }
                    .onEnded { _ in
                        isDrawerDragging = false
                        drawerDragStartWidth = nil
                        drawerDragStartAvailableWidth = nil
                    }
            )
            .onDisappear {
                isDrawerDragging = false
                drawerDragStartWidth = nil
                drawerDragStartAvailableWidth = nil
            }
    }

    // MARK: - Config-Driven Slot Rendering

    @ViewBuilder
    private func slotView(for content: SlotContent) -> some View {
        switch content {
        case .native(let panelId): nativePanelView(panelId)
        case .surface(let surfaceId): surfaceSlotView(surfaceId: surfaceId)
        case .empty: EmptyView()
        }
    }

    @ViewBuilder
    private func nativePanelView(_ panelId: NativePanelId) -> some View {
        switch panelId {
        case .chat:
            chatView
        case .activity:
            if let viewModel = threadManager.activeViewModel,
               let messageId = windowState.activityMessageId {
                ActivityPanel(
                    viewModel: viewModel,
                    messageId: messageId,
                    onClose: { windowState.activePanel = nil }
                )
            }
        case .settings:
            SettingsPanel(onClose: { windowState.activePanel = nil }, store: settingsStore, daemonClient: daemonClient, threadManager: threadManager)
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
                    viewModel.pendingSkillInvocation = nil
                }
                windowState.activePanel = nil
            }, daemonClient: daemonClient)
        case .debug:
            DebugPanel(
                traceStore: traceStore,
                daemonClient: daemonClient,
                activeSessionId: threadManager.activeViewModel?.sessionId,
                onClose: { windowState.activePanel = nil }
            )
        case .doctor:
            DoctorPanel(onClose: { windowState.activePanel = nil })
        case .directory:
            AppDirectoryView(
                daemonClient: daemonClient,
                onBack: { windowState.activePanel = nil },
                onOpenApp: { surfaceMsg in
                    windowState.activeDynamicSurface = surfaceMsg
                    windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                    windowState.activePanel = .generated
                    windowState.isDynamicExpanded = true
                }
            )
        case .generated:
            GeneratedPanel(
                onClose: { showSharePicker = false; windowState.closeDynamicPanel() },
                isExpanded: $windowState.isDynamicExpanded,
                daemonClient: daemonClient,
                onOpenApp: { surfaceMsg in
                    windowState.activeDynamicSurface = surfaceMsg
                    windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                }
            )
        case .threadList:
            threadDrawerView
        }
    }

    @ViewBuilder
    private func surfaceSlotView(surfaceId: String) -> some View {
        if let surface = surfaceManager.activeSurfaces[surfaceId],
           case .dynamicPage(let dpData) = surface.data {
            DynamicPageSurfaceView(
                data: dpData,
                onAction: { actionId, actionData in
                    if !windowState.isChatDockOpen {
                        windowState.isChatDockOpen = true
                    }
                    surfaceManager.onAction?(surface.sessionId, surface.id, actionId, actionData as? [String: Any])
                },
                onLinkOpen: { url, metadata in
                    surfaceManager.onLinkOpen?(url, metadata)
                }
            )
        } else {
            VStack {
                Spacer()
                Text("Surface not available")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.background)
        }
    }

    @ViewBuilder
    private func chatContentView(geometry: GeometryProxy) -> some View {
        if windowState.activePanel == .directory {
            AppDirectoryView(
                daemonClient: daemonClient,
                onBack: { windowState.activePanel = nil },
                onOpenApp: { surfaceMsg in
                    windowState.activeDynamicSurface = surfaceMsg
                    windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                    windowState.activePanel = .generated
                    windowState.isDynamicExpanded = true
                }
            )
        } else if windowState.isDynamicExpanded && windowState.activePanel == .generated {
            if let surface = windowState.activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data {
                VSplitView(
                    panelWidth: $sidePanelWidth,
                    showPanel: windowState.isChatDockOpen,
                    main: {
                        dynamicWorkspaceView(surface: surface, data: dpData)
                    },
                    panel: {
                        chatView
                    }
                )
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
        } else if let panel = windowState.activePanel, panel != .activity {
            // Full-window panels: settings, skills, debug, doctor
            fullWindowPanel(panel)
        } else {
            let config = windowState.layoutConfig
            let showActivity = windowState.activePanel == .activity
                && threadManager.activeViewModel != nil
                && windowState.activityMessageId != nil
            let showConfigPanel = config.right.visible && config.right.content != .empty

            VSplitView(
                panelWidth: $sidePanelWidth,
                showPanel: showActivity || showConfigPanel,
                main: { slotView(for: config.center.content) },
                panel: {
                    if showActivity,
                       let viewModel = threadManager.activeViewModel,
                       let messageId = windowState.activityMessageId {
                        ActivityPanel(
                            viewModel: viewModel,
                            messageId: messageId,
                            onClose: { windowState.activePanel = nil }
                        )
                    } else {
                        slotView(for: config.right.content)
                    }
                }
            )
        }
    }

    @ViewBuilder
    private var chatView: some View {
        if let viewModel = threadManager.activeViewModel {
            ActiveChatViewWrapper(
                viewModel: viewModel,
                windowState: windowState,
                ambientAgent: ambientAgent,
                onMicrophoneToggle: onMicrophoneToggle
            )
        }
    }

    @ViewBuilder
    private func fullWindowPanel(_ panel: SidePanelType) -> some View {
        switch panel {
        case .settings:
            SettingsPanel(onClose: { windowState.activePanel = nil }, store: settingsStore, daemonClient: daemonClient, threadManager: threadManager)
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
                    viewModel.pendingSkillInvocation = nil
                }
                windowState.activePanel = nil
            }, daemonClient: daemonClient)
        case .debug:
            DebugPanel(
                traceStore: traceStore,
                daemonClient: daemonClient,
                activeSessionId: threadManager.activeViewModel?.sessionId,
                onClose: { windowState.activePanel = nil }
            )
        case .doctor:
            DoctorPanel(onClose: { windowState.activePanel = nil })
        case .generated:
            // Generated panel is handled inline in chatContentView when expanded;
            // if we reach here, isDynamicExpanded is false — clear activePanel so
            // the user falls back to the chat view instead of seeing a blank screen.
            Color.clear.frame(width: 0, height: 0)
                .onAppear { windowState.activePanel = nil }
        default:
            EmptyView()
        }
    }

    // MARK: - Dynamic Workspace

    @ViewBuilder
    private func dynamicWorkspaceView(surface: Surface, data: DynamicPageSurfaceData) -> some View {
        if let viewModel = threadManager.activeViewModel {
            DynamicWorkspaceWrapper(
                viewModel: viewModel,
                surface: surface,
                data: data,
                windowState: windowState,
                surfaceManager: surfaceManager,
                daemonClient: daemonClient,
                trafficLightPadding: trafficLightPadding,
                isPublishing: $isPublishing,
                publishedUrl: $publishedUrl,
                publishError: $publishError,
                isBundling: $isBundling,
                showSharePicker: $showSharePicker,
                shareFileURL: $shareFileURL,
                workspaceEditorContentHeight: $workspaceEditorContentHeight,
                onPublishPage: publishPage,
                onBundleAndShare: bundleAndShare,
                isChatDockOpen: windowState.isChatDockOpen,
                onToggleChatDock: { windowState.toggleChatDock() },
                onMicrophoneToggle: onMicrophoneToggle,
                onClose: { windowState.closeDynamicPanel() }
            )
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

private struct NewConversationButton: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(isHovered ? VColor.textPrimary : VColor.textMuted)
                    .frame(width: 22, height: 22)
                    .overlay(
                        Circle()
                            .stroke(isHovered ? VColor.textMuted : VColor.textMuted.opacity(0.5), lineWidth: 1)
                    )
                Text("New conversation")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(VColor.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .background(isHovered ? VColor.hoverOverlay.opacity(0.06) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                isHovered = hovering
            }
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

private struct ControlCenterMenuButton: View {
    let onSettings: () -> Void
    let onSkills: () -> Void
    let onDirectory: () -> Void
    let onDebug: () -> Void
    let onDoctor: () -> Void
    @State private var isHovered = false
    @State private var showDrawer = false

    var body: some View {
        Button {
            withAnimation(VAnimation.fast) {
                showDrawer.toggle()
            }
        } label: {
            HStack(spacing: VSpacing.md) {
                Image("OwlIcon")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundColor(VColor.textSecondary)
                    .frame(width: 20, height: 20)

                Text("Control Center")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textPrimary)

                Spacer()

                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(VColor.textMuted)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(isHovered || showDrawer ? VColor.hoverOverlay.opacity(0.05) : Color.clear)
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovered = hovering
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            if showDrawer {
                DrawerMenuView(
                    onSettings: { showDrawer = false; onSettings() },
                    onSkills: { showDrawer = false; onSkills() },
                    onDirectory: { showDrawer = false; onDirectory() },
                    onDebug: { showDrawer = false; onDebug() },
                    onDoctor: { showDrawer = false; onDoctor() }
                )
                .offset(y: -68)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
    }
}

private struct DrawerMenuView: View {
    let onSettings: () -> Void
    let onSkills: () -> Void
    let onDirectory: () -> Void
    let onDebug: () -> Void
    let onDoctor: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DrawerMenuItem(icon: "gearshape", label: "Settings", action: onSettings)
            DrawerMenuItem(icon: "wand.and.stars", label: "Skills", action: onSkills)
            DrawerMenuItem(icon: "doc.text", label: "Directory", action: onDirectory)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            DrawerMenuItem(icon: "ladybug", label: "Debug", action: onDebug)
            DrawerMenuItem(icon: "stethoscope", label: "Vellum Doctor", action: onDoctor)
        }
        .padding(.vertical, VSpacing.sm)
        .frame(maxWidth: .infinity)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.3), radius: 12, y: -4)
        .padding(.horizontal, VSpacing.sm)
    }
}

private struct DrawerMenuItem: View {
    let icon: String
    let label: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isHovered ? VColor.textPrimary : VColor.textSecondary)
                    .frame(width: 18)
                    .rotationEffect(.degrees(isHovered ? -10 : 0))
                    .scaleEffect(isHovered ? 1.15 : 1.0)
                    .animation(VAnimation.fast, value: isHovered)
                Text(label)
                    .font(.custom("Inter", size: 13))
                    .foregroundColor(VColor.textPrimary)
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isHovered ? VColor.hoverOverlay.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}


// MARK: - File Picker Helper

@MainActor
private func openFilePicker(viewModel: ChatViewModel) {
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

// MARK: - Wrapper Views
// These observe the ChatViewModel directly so that only the views that
// actually need ChatViewModel state are invalidated on change, instead
// of propagating every change up through ThreadManager.

/// Observes the active ChatViewModel and renders the chat interface.
private struct ActiveChatViewWrapper: View {
    @ObservedObject var viewModel: ChatViewModel
    @ObservedObject var windowState: MainWindowState
    let ambientAgent: AmbientAgent
    let onMicrophoneToggle: () -> Void

    var body: some View {
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
                windowState.activePanel = .settings
            },
            onSend: viewModel.sendMessage,
            onStop: viewModel.stopGenerating,
            onDismissError: viewModel.dismissError,
            isRetryableError: viewModel.isRetryableError,
            onRetryError: { viewModel.retryLastMessage() },
            onAcceptSuggestion: viewModel.acceptSuggestion,
            onAttach: { openFilePicker(viewModel: viewModel) },
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
            onCopyDebugInfo: { viewModel.copySessionErrorDebugDetails() },
            watchSession: ambientAgent.activeWatchSession,
            onStopWatch: { viewModel.stopWatchSession() },
            onOpenActivity: { messageId in
                windowState.toggleActivityPanel(with: messageId)
            },
            isActivityPanelOpen: windowState.activePanel == .activity
        )
    }
}

/// Observes the active ChatViewModel and renders the dynamic workspace overlays.
private struct DynamicWorkspaceWrapper: View {
    @ObservedObject var viewModel: ChatViewModel
    let surface: Surface
    let data: DynamicPageSurfaceData
    @ObservedObject var windowState: MainWindowState
    let surfaceManager: SurfaceManager
    let daemonClient: DaemonClient
    let trafficLightPadding: CGFloat
    @Binding var isPublishing: Bool
    @Binding var publishedUrl: String?
    @Binding var publishError: String?
    @Binding var isBundling: Bool
    @Binding var showSharePicker: Bool
    @Binding var shareFileURL: URL?
    @Binding var workspaceEditorContentHeight: CGFloat
    let onPublishPage: (String, String?) -> Void
    let onBundleAndShare: (String) -> Void
    let isChatDockOpen: Bool
    let onToggleChatDock: () -> Void
    let onMicrophoneToggle: () -> Void
    var onClose: (() -> Void)?

    private var composerReservedHeight: CGFloat {
        guard !isChatDockOpen else { return 0 }
        let editorClamped = min(max(workspaceEditorContentHeight, 14), 200)
        let contentHeight = max(editorClamped, 28)
        let expanded = windowState.workspaceComposerExpanded
        let topPad: CGFloat = expanded ? VSpacing.lg : VSpacing.sm
        let buttonRow: CGFloat = expanded ? 28 + VSpacing.xs : 0
        let hasAttachments = !viewModel.pendingAttachments.isEmpty
        let attachmentStrip: CGFloat = hasAttachments ? VSpacing.sm + 36 + VSpacing.xs : 0
        return VSpacing.sm + VSpacing.md + topPad + VSpacing.sm + contentHeight + buttonRow + attachmentStrip
    }

    var body: some View {
        ZStack {
            DynamicPageSurfaceView(
                data: data,
                onAction: { actionId, actionData in
                    if !isChatDockOpen {
                        onToggleChatDock()
                    }
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
                onPageChanged: { [weak viewModel] page in
                    viewModel?.currentPage = page
                },
                onSnapshotCaptured: data.appId != nil ? { [weak daemonClient] base64 in
                    guard let appId = data.appId else { return }
                    try? daemonClient?.sendAppUpdatePreview(appId: appId, preview: base64)
                } : nil,
                onLinkOpen: { url, metadata in
                    surfaceManager.onLinkOpen?(url, metadata)
                },
                topContentInset: 56,
                bottomContentInset: composerReservedHeight
            )

            VStack(spacing: 0) {
                HStack {
                    Button(action: {
                        if !isChatDockOpen {
                            windowState.workspaceComposerExpanded = false
                        }
                        onToggleChatDock()
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: isChatDockOpen ? "arrow.down.left.and.arrow.up.right" : "arrow.up.right.and.arrow.down.left")
                                .font(.system(size: 12, weight: .semibold))
                            Text(isChatDockOpen ? "Move Chat To Bottom" : "Move Chat To Side")
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
                    .accessibilityLabel(isChatDockOpen ? "Move chat to bottom composer" : "Move chat to docked side panel")

                    Spacer()

                    if viewModel.surfaceUndoCount > 0 {
                        Button(action: {
                            viewModel.undoSurfaceRefinement()
                        }) {
                            Image(systemName: "arrow.uturn.backward")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(VColor.textPrimary)
                                .frame(width: 32, height: 32)
                                .background(
                                    Circle()
                                        .fill(VColor.surface.opacity(0.85))
                                        .overlay(Circle().stroke(VColor.surfaceBorder, lineWidth: 1))
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Undo")
                        .transition(.opacity)
                        .animation(VAnimation.standard, value: viewModel.surfaceUndoCount)
                    }

                    if data.appId == nil || data.appType == "site" {
                        Button(action: {
                            onPublishPage(data.html, data.preview?.title)
                        }) {
                            Group {
                                if isPublishing {
                                    ProgressView()
                                        .controlSize(.small)
                                        .scaleEffect(0.7)
                                } else if publishedUrl != nil {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.system(size: 12, weight: .medium))
                                } else {
                                    Image(systemName: "globe")
                                        .font(.system(size: 12, weight: .medium))
                                }
                            }
                            .foregroundColor(publishedUrl != nil ? VColor.success : VColor.textPrimary)
                            .frame(width: 32, height: 32)
                            .background(
                                Circle()
                                    .fill(VColor.surface.opacity(0.85))
                                    .overlay(Circle().stroke(VColor.surfaceBorder, lineWidth: 1))
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(isPublishing)
                        .accessibilityLabel(publishedUrl != nil ? "Published" : "Publish")

                        if let url = publishedUrl {
                            Button(action: {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(url, forType: .string)
                            }) {
                                HStack(spacing: VSpacing.xs) {
                                    Image(systemName: "doc.on.doc")
                                        .font(.system(size: 10, weight: .medium))
                                    Text(url)
                                        .font(VFont.caption)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                .foregroundColor(VColor.textSecondary)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, VSpacing.xs)
                                .background(
                                    Capsule()
                                        .fill(VColor.surface.opacity(0.85))
                                        .overlay(Capsule().stroke(VColor.surfaceBorder, lineWidth: 1))
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Copy published URL")
                            .frame(maxWidth: 200)
                        }

                        if let error = publishError {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.system(size: 10, weight: .medium))
                                Text(error)
                                    .font(VFont.caption)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                            .foregroundColor(VColor.error)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .background(
                                Capsule()
                                    .fill(VColor.error.opacity(0.15))
                                    .overlay(Capsule().stroke(VColor.error.opacity(0.3), lineWidth: 1))
                            )
                            .frame(maxWidth: 200)
                            .transition(.opacity)
                        }
                    }

                    if let appId = data.appId {
                        Button(action: {
                            onBundleAndShare(appId)
                        }) {
                            Group {
                                if isBundling {
                                    ProgressView()
                                        .controlSize(.small)
                                        .scaleEffect(0.7)
                                } else {
                                    Image(systemName: "square.and.arrow.up")
                                        .font(.system(size: 12, weight: .medium))
                                }
                            }
                            .foregroundColor(VColor.textPrimary)
                            .frame(width: 32, height: 32)
                            .background(
                                Circle()
                                    .fill(VColor.surface.opacity(0.85))
                                    .overlay(Circle().stroke(VColor.surfaceBorder, lineWidth: 1))
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(isBundling)
                        .accessibilityLabel("Share")
                        .background(
                            ShareSheetButton(
                                items: shareFileURL != nil ? [shareFileURL!] : [],
                                isPresented: Binding(
                                    get: { showSharePicker },
                                    set: { newValue in
                                        showSharePicker = newValue
                                        if !newValue { shareFileURL = nil }
                                    }
                                )
                            )
                            .frame(width: 1, height: 1)
                        )
                    }

                    if onClose != nil {
                        Button(action: { onClose?() }) {
                            Image(systemName: "xmark")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(VColor.textPrimary)
                                .frame(width: 32, height: 32)
                                .background(
                                    Circle()
                                        .fill(VColor.surface.opacity(0.85))
                                        .overlay(Circle().stroke(VColor.surfaceBorder, lineWidth: 1))
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Close dashboard")
                    }
                }
                .padding(.leading, trafficLightPadding)
                .padding(.trailing, VSpacing.xl)
                .padding(.top, VSpacing.md)

                Spacer()

                WorkspaceActivityFeed(viewModel: viewModel)

                if !isChatDockOpen {
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
                        onAttach: { openFilePicker(viewModel: viewModel) },
                        onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
                        onPaste: { viewModel.addAttachmentFromPasteboard() },
                        onMicrophoneToggle: onMicrophoneToggle,
                        placeholderText: "Message your assistant...",
                        editorContentHeight: $workspaceEditorContentHeight,
                        isComposerExpanded: $windowState.workspaceComposerExpanded
                    )
                }
            }
        }
    }
}

struct MainWindowView_Previews: PreviewProvider {
    static var previews: some View {
        let dc = DaemonClient()
        MainWindowView(threadManager: ThreadManager(daemonClient: dc), zoomManager: ZoomManager(), traceStore: TraceStore(), daemonClient: dc, surfaceManager: SurfaceManager(), ambientAgent: AmbientAgent(), settingsStore: SettingsStore(daemonClient: dc), windowState: MainWindowState())
            .frame(width: 900, height: 600)
            .padding(.top, 36)
    }
}
