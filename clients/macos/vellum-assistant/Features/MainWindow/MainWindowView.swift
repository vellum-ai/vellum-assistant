import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var appListManager: AppListManager
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
    @State private var isHoveredApp: String?
    @State private var requestedHomeBaseAtLaunch = false
    @State private var threadPendingDeletion: UUID?
    @State private var showAllThreads: Bool = false
    @State private var showAllApps: Bool = false
    @State private var showControlCenterDrawer: Bool = false
    @AppStorage("isAppChatOpen") private var isAppChatOpen: Bool = false
    @State private var jitPermissionManager = JITPermissionManager()
    /// Stores the thread ID the user was on before entering temporary chat,
    /// so we can restore it when they exit instead of jumping to visibleThreads.first
    /// (which may be a pinned thread unrelated to what they were doing).
    @State private var preTemporaryChatThreadId: UUID?

    @AppStorage("sidebarOpen") private var sidebarOpen: Bool = false
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var systemIsDark: Bool = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    @AppStorage("threadDrawerWidth") private var threadDrawerWidth: Double = 240
    @AppStorage("sidePanelWidth") private var sidePanelWidth: Double = 400
    @AppStorage("homeBaseDashboardDefaultEnabled") private var homeBaseDashboardDefaultEnabled: Bool = false
    @State private var drawerDragStartWidth: Double?
    @State private var drawerDragStartAvailableWidth: CGFloat?
    @State private var isDrawerDragging: Bool = false
    private let drawerDragCoordinateSpaceName = "MainWindowDrawerDragCoordinateSpace"
    let daemonClient: DaemonClient
    let surfaceManager: SurfaceManager
    let ambientAgent: AmbientAgent
    let settingsStore: SettingsStore
    @ObservedObject var documentManager: DocumentManager
    let onMicrophoneToggle: () -> Void

    init(threadManager: ThreadManager, appListManager: AppListManager, zoomManager: ZoomManager, traceStore: TraceStore, daemonClient: DaemonClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, settingsStore: SettingsStore, windowState: MainWindowState, documentManager: DocumentManager, onMicrophoneToggle: @escaping () -> Void = {}) {
        self.threadManager = threadManager
        self.appListManager = appListManager
        self.zoomManager = zoomManager
        self.traceStore = traceStore
        self.daemonClient = daemonClient
        self.surfaceManager = surfaceManager
        self.ambientAgent = ambientAgent
        self.settingsStore = settingsStore
        self.windowState = windowState
        self.documentManager = documentManager
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

    private func publishPage(html: String, title: String?, appId: String? = nil) {
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
                try daemonClient.sendPublishPage(html: html, title: title, appId: appId)
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

    private func toggleTemporaryChat() {
        if threadManager.activeThread?.kind == .private {
            // Restore the thread the user was on before entering temporary chat.
            // Fall back to visibleThreads.first only if the stored thread no longer exists.
            if let savedId = preTemporaryChatThreadId,
               threadManager.visibleThreads.contains(where: { $0.id == savedId }) {
                threadManager.selectThread(id: savedId)
            } else if let recent = threadManager.visibleThreads.first {
                threadManager.selectThread(id: recent.id)
            } else {
                threadManager.createThread()
            }
            preTemporaryChatThreadId = nil
        } else {
            preTemporaryChatThreadId = threadManager.activeThreadId
            threadManager.createPrivateThread()
        }
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
            self.appListManager.recordAppOpen(
                id: homeBase.appId,
                name: homeBase.preview.title,
                icon: homeBase.preview.icon
            )
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
            .onChange(of: windowState.selection) { oldSelection, newSelection in
                // When selection transitions to .thread, ensure ThreadManager is synced
                // so chat content targets the correct thread (e.g. after dismissOverlay).
                // Guard against archived threads: if the thread was archived while an
                // overlay was open, persistentThreadId may still point to the stale ID.
                if case .thread(let id) = newSelection {
                    if threadManager.threads.contains(where: { $0.id == id && !$0.isArchived }) {
                        threadManager.selectThread(id: id)
                    } else {
                        // Thread was archived/deleted — fall back to the first visible thread
                        if let fallback = threadManager.visibleThreads.first {
                            windowState.selection = .thread(fallback.id)
                        } else {
                            windowState.selection = nil
                        }
                    }
                }

                // Sync surface and chat dock state when selection changes
                let expanded = windowState.isDynamicExpanded
                let docked = windowState.isChatDockOpen
                threadManager.activeViewModel?.activeSurfaceId = expanded ? windowState.activeDynamicSurface?.surfaceId : nil
                threadManager.activeViewModel?.isChatDockedToSide = expanded && docked

                // Reset expanded state and active surface when navigating away from app/generated
                let oldIsApp: Bool = {
                    switch oldSelection {
                    case .app, .appEditing: return true
                    case .panel(.generated): return true
                    default: return false
                    }
                }()
                let newIsApp: Bool = {
                    switch newSelection {
                    case .app, .appEditing: return true
                    case .panel(.generated): return true
                    default: return false
                    }
                }()
                if oldIsApp && !newIsApp {
                    showSharePicker = false
                    windowState.activeDynamicSurface = nil
                    windowState.activeDynamicParsedSurface = nil
                }

                // Close the left sidebar when the activity panel opens to avoid crowding
                if case .panel(.activity) = newSelection, sidebarOpen {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        sidebarOpen = false
                    }
                }
            }
            .onChange(of: windowState.activeDynamicSurface?.surfaceId) { _, surfaceId in
                if windowState.isDynamicExpanded {
                    threadManager.activeViewModel?.activeSurfaceId = surfaceId
                }
            }
            .onChange(of: threadManager.activeViewModel?.messages.map(\.id)) { _, _ in
                // Close activity panel if the referenced message no longer exists.
                // Watch message IDs (not just count) so that regenerate/undo flows
                // that replace a message with a new ID at the same array position
                // also trigger a close.
                if let messageId = windowState.activityMessageId,
                   windowState.activePanel == .activity,
                   let viewModel = threadManager.activeViewModel {
                    let messageExists = viewModel.messages.contains(where: { $0.id == messageId })
                    if !messageExists {
                        windowState.selection = nil
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
                VStack(spacing: 0) {
                    // Top bar — full-width, darkest background
                    HStack(spacing: 0) {
                        VIconButton(label: "Sidebar", icon: "sidebar.left", isActive: sidebarOpen, iconOnly: true) {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                sidebarOpen.toggle()
                            }
                        }
                        Spacer()
                        if !isGeneratedWorkspaceOpen {
                            TemporaryChatToggle(
                                isActive: threadManager.activeThread?.kind == .private,
                                onToggle: { toggleTemporaryChat() }
                            )
                        }
                    }
                    .padding(.leading, trafficLightPadding)
                    .padding(.trailing, VSpacing.lg)
                    .frame(height: 36)
                    .background(VColor.background)

                    // Sidebar + main content
                    HStack(spacing: 0) {
                        // Left: Full-height sidebar (always rendered, width collapses to 0)
                        sidebarView
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                            .frame(width: sidebarOpen && windowState.layoutConfig.left.visible ? threadDrawerWidth : 0, alignment: .leading)
                            .clipped()
                            .allowsHitTesting(sidebarOpen && windowState.layoutConfig.left.visible)
                            .animation(isDrawerDragging ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: sidebarOpen)
                            .animation(nil, value: threadDrawerWidth)

                        if sidebarOpen && windowState.layoutConfig.left.visible {
                            drawerDragDivider(availableWidth: geometry.size.width / zoomManager.zoomLevel)
                        }

                        // Right: Main content
                        chatContentView(geometry: geometry)
                    }
                    .padding(.leading, VSpacing.sm)
                    .padding(.bottom, VSpacing.sm)
                }
                .coordinateSpace(name: drawerDragCoordinateSpaceName)
                .overlay {
                    // Click-outside-to-dismiss background for control center drawer
                    if showControlCenterDrawer {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture {
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                                    showControlCenterDrawer = false
                                }
                            }
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    // Control center drawer rendered at top level so it floats above all content
                    if showControlCenterDrawer {
                        DrawerMenuView(
                            onIdentity: {
                                showControlCenterDrawer = false
                                windowState.togglePanel(.identity)
                            },
                            onSkills: {
                                showControlCenterDrawer = false
                                windowState.togglePanel(.agent)
                            },
                            onSettings: {
                                showControlCenterDrawer = false
                                windowState.togglePanel(.settings)
                            },
                            onDebug: {
                                showControlCenterDrawer = false
                                windowState.togglePanel(.debug)
                            },
                            onDoctor: {
                                showControlCenterDrawer = false
                                windowState.togglePanel(.doctor)
                            }
                        )
                        .frame(width: 200)
                        .offset(x: threadDrawerWidth + 8, y: -8)
                        .zIndex(10)
                        .transition(.move(edge: .leading).combined(with: .opacity))
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
        .overlay(alignment: .bottom) {
            if let toast = windowState.toastInfo {
                VToast(
                    message: toast.message,
                    style: toast.style == .success ? .success : .error,
                    primaryAction: toast.primaryAction,
                    onDismiss: { windowState.dismissToast() }
                )
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.xl)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(VAnimation.standard, value: windowState.toastInfo != nil)
        .overlay {
            JITPermissionView(manager: jitPermissionManager)
        }
        .onAppear {
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
            selectedThreadId = threadManager.activeThreadId
            // Initialize persistent thread tracking on launch
            if let activeId = threadManager.activeThreadId {
                windowState.persistentThreadId = activeId
            }
            requestHomeBaseDashboardIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
        }
        .onReceive(daemonClient.$isConnected) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
            requestHomeBaseDashboardIfNeeded()
        }
        .onChange(of: sidebarOpen) { _, isOpen in
            if !isOpen && showControlCenterDrawer {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                    showControlCenterDrawer = false
                }
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
            // Update persistentThreadId when the active thread changes, but only
            // if the user is currently viewing a thread or has no selection (not an overlay).
            if let newId {
                switch windowState.selection {
                case .thread, .none, .appEditing:
                    windowState.persistentThreadId = newId
                default:
                    break
                }
            }
            // Close the activity panel when switching threads — the stored messageId
            // belongs to the previous thread and won't exist in the new one.
            if case .panel(.activity) = windowState.selection {
                windowState.selection = nil
                windowState.activityMessageId = nil
            } else if case .panel(.identity) = windowState.selection {
                windowState.selection = nil
            }
            // Clear stale activeSurfaceId on the old thread and sync the new one
            if let oldId {
                threadManager.clearActiveSurface(threadId: oldId)
            }
            threadManager.activeViewModel?.activeSurfaceId = windowState.isDynamicExpanded ? windowState.activeDynamicSurface?.surfaceId : nil
            threadManager.activeViewModel?.isChatDockedToSide = windowState.isDynamicExpanded && windowState.isChatDockOpen
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDynamicWorkspace)) { notification in
            if let msg = notification.userInfo?["surfaceMessage"] as? UiSurfaceShowMessage {
                windowState.activeDynamicSurface = msg
                windowState.activeDynamicParsedSurface = Surface.from(msg)
                // Determine the app ID from the surface if available
                if let surface = windowState.activeDynamicParsedSurface,
                   case .dynamicPage(let dpData) = surface.data,
                   let appId = dpData.appId {
                    windowState.selection = .app(appId)
                } else {
                    windowState.selection = .app(msg.surfaceId)
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDocumentEditor)) { _ in
            windowState.selection = .panel(.documentEditor)
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
                    windowState.closeDynamicPanel()
                }
            } else {
                // Bulk dismiss (dismissAll) — only clear if currently showing an app workspace.
                // Avoid kicking the user out of unrelated panels (Settings, Agent, etc.).
                if case .app = windowState.selection {
                    showSharePicker = false
                    windowState.closeDynamicPanel()
                } else if case .appEditing = windowState.selection {
                    showSharePicker = false
                    windowState.closeDynamicPanel()
                }
            }
        }
        .onChange(of: isHoveredThread) { _, newValue in
            // Cancel pending archive when the user hovers a *different* thread.
            // Skip clearing when newValue is nil (e.g. menu dismissal triggers
            // a momentary hover-leave) so the Confirm button stays visible.
            if let pending = threadPendingDeletion, let newValue, newValue != pending {
                threadPendingDeletion = nil
            }
        }
    }

    @ViewBuilder
    private func threadItem(_ thread: ThreadModel) -> some View {
        let isSelected: Bool = {
            if thread.id == windowState.persistentThreadId { return true }
            if case .thread(let id) = windowState.selection, id == thread.id { return true }
            if case .appEditing(_, let threadId) = windowState.selection, threadId == thread.id { return true }
            return false
        }()
        let isHovered = isHoveredThread == thread.id
        Button(action: {
            if case .appEditing(let appId, _) = windowState.selection {
                // Stay in editing mode, just switch the thread
                windowState.selection = .appEditing(appId: appId, threadId: thread.id)
                threadManager.selectThread(id: thread.id)
            } else {
                // Normal thread selection
                windowState.selection = .thread(thread.id)
                threadManager.selectThread(id: thread.id)
            }
        }) {
            HStack(spacing: VSpacing.xs) {
                if thread.kind == .private {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(VColor.accent.opacity(0.7))
                }
                Text(thread.title)
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .background {
                if isSelected || isHovered {
                    VColor.hoverOverlay.opacity(0.08)
                } else if thread.kind == .private {
                    VColor.accent.opacity(0.04)
                } else {
                    Color.clear
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            if threadPendingDeletion == thread.id {
                Button {
                    threadManager.archiveThread(id: thread.id)
                    threadPendingDeletion = nil
                } label: {
                    Text("Confirm")
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                        .padding(.horizontal, VSpacing.sm)
                        .frame(height: 24)
                        .background(VColor.surface)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Confirm archive \(thread.title)")
            } else if isHovered {
                HStack(spacing: VSpacing.xs) {
                    Button {
                        if thread.isPinned {
                            threadManager.unpinThread(id: thread.id)
                        } else {
                            threadManager.pinThread(id: thread.id)
                        }
                    } label: {
                        Image(systemName: thread.isPinned ? "pin.fill" : "pin")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(thread.isPinned ? VColor.textMuted : VColor.textSecondary)
                            .rotationEffect(.degrees(-45))
                            .frame(width: 20, height: 20)
                            .background(VColor.backgroundSubtle)
                            .clipShape(Circle())
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(thread.isPinned ? "Unpin \(thread.title)" : "Pin \(thread.title)")

                    Button {
                        threadPendingDeletion = thread.id
                    } label: {
                        Image(systemName: "archivebox")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textSecondary)
                            .frame(width: 20, height: 20)
                            .background(VColor.backgroundSubtle)
                            .clipShape(Circle())
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Archive \(thread.title)")
                }
                .padding(.trailing, VSpacing.xs)
            } else if thread.isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(VColor.textMuted)
                    .rotationEffect(.degrees(-45))
                    .frame(width: 20, height: 20)
                    .background(VColor.backgroundSubtle)
                    .clipShape(Circle())
                    .padding(.trailing, VSpacing.xs)
            }
        }
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
        .draggable(thread.id.uuidString)
    }

    private var displayedThreads: [ThreadModel] {
        let visible = threadManager.visibleThreads
        return showAllThreads ? visible : Array(visible.prefix(5))
    }

    private var displayedApps: [AppListManager.AppItem] {
        let all = appListManager.displayApps
        return showAllApps ? all : Array(all.prefix(5))
    }

    @ViewBuilder
    private var sidebarView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    // MARK: Threads Section
                    VStack(spacing: VSpacing.xs) {
                        SidebarSectionHeader(title: "Threads") {
                            NewConversationButton(action: { windowState.selection = nil; threadManager.createThread() })
                        }

                        ForEach(displayedThreads) { thread in
                            threadItem(thread)
                                .dropDestination(for: String.self) { items, _ in
                                    guard let droppedId = items.first,
                                          let sourceUUID = UUID(uuidString: droppedId),
                                          sourceUUID != thread.id else { return false }
                                    return threadManager.moveThread(sourceId: sourceUUID, beforeId: thread.id)
                                } isTargeted: { _ in }
                        }

                        if threadManager.visibleThreads.count > 5 {
                            Button {
                                withAnimation(VAnimation.standard) { showAllThreads.toggle() }
                            } label: {
                                Text(showAllThreads ? "Show less" : "Show more")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.leading, VSpacing.lg)
                                    .padding(.vertical, VSpacing.xs)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.bottom, VSpacing.md)

                    VColor.background.frame(height: 1)
                        .padding(.horizontal, VSpacing.sm)

                    // MARK: Apps Section
                    VStack(spacing: VSpacing.xs) {
                        SidebarSectionHeader(title: "Apps") {
                            VButton(label: "Directory", style: .ghost) {
                                windowState.togglePanel(.directory)
                            }
                            .controlSize(.small)
                        }

                        if !appListManager.apps.isEmpty {
                            ForEach(displayedApps) { app in
                                sidebarAppItem(app)
                                    .dropDestination(for: String.self) { items, _ in
                                        guard let droppedId = items.first,
                                              droppedId != app.id else { return false }
                                        return appListManager.moveApp(sourceId: droppedId, beforeId: app.id)
                                    } isTargeted: { _ in }
                            }

                            if appListManager.displayApps.count > 5 {
                                Button {
                                    withAnimation(VAnimation.standard) { showAllApps.toggle() }
                                } label: {
                                    Text(showAllApps ? "Show less" : "Show more")
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.textMuted)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.leading, VSpacing.lg)
                                        .padding(.vertical, VSpacing.xs)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.top, VSpacing.md)
                }
                .padding(VSpacing.xs)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .padding(.horizontal, VSpacing.xs)
                .padding(.top, VSpacing.xs)
            }
            .scrollClipDisabled()
            .clipped()

            Spacer(minLength: 0)

            // Control Center pill button
            ControlCenterMenuButton(
                isOpen: showControlCenterDrawer,
                onToggle: {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                        showControlCenterDrawer.toggle()
                    }
                }
            )
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.md)
            .zIndex(1)
        }
        .frame(width: threadDrawerWidth)
        .background(VColor.backgroundSubtle)
    }

    @ViewBuilder
    private func sidebarAppItem(_ app: AppListManager.AppItem) -> some View {
        let isSelected = false
        Button(action: {
            // Clicking a different app exits edit mode; same app stays in .app mode
            windowState.selection = .app(app.id)
            openAppInWorkspace(app: app)
        }) {
            HStack(spacing: VSpacing.sm) {
                Text(app.name)
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .background(isSelected || isHoveredApp == app.id ? VColor.hoverOverlay.opacity(0.08) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            if isHoveredApp == app.id {
                Button {
                    if app.isPinned {
                        appListManager.unpinApp(id: app.id)
                    } else {
                        appListManager.pinApp(id: app.id)
                    }
                } label: {
                    Image(systemName: app.isPinned ? "pin.fill" : "pin")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(app.isPinned ? VColor.textMuted : VColor.textSecondary)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(app.isPinned ? "Unpin \(app.name)" : "Pin \(app.name)")
                .padding(.trailing, VSpacing.xs)
            } else if app.isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(VColor.textMuted)
                    .rotationEffect(.degrees(-45))
                    .frame(width: 20, height: 20)
                    .padding(.trailing, VSpacing.xs)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .onHover { hovering in
            if hovering {
                isHoveredApp = app.id
                NSCursor.pointingHand.push()
            } else {
                if isHoveredApp == app.id {
                    isHoveredApp = nil
                }
                NSCursor.pop()
            }
        }
        .contextMenu {
            Button(app.isPinned ? "Unpin" : "Pin to Top") {
                if app.isPinned {
                    appListManager.unpinApp(id: app.id)
                } else {
                    appListManager.pinApp(id: app.id)
                }
            }
            Button("Open") {
                openAppInWorkspace(app: app)
            }
            Divider()
            Button("Remove from Recents", role: .destructive) {
                appListManager.removeApp(id: app.id)
            }
        }
        .draggable(app.id)
    }

    // MARK: - App View Helpers

    /// Check if a given appId matches the currently active workspace surface.
    private func isAppSurfaceActive(appId: String) -> Bool {
        guard let surfaceMsg = windowState.activeDynamicSurface,
              let surface = windowState.activeDynamicParsedSurface,
              case .dynamicPage(let dpData) = surface.data else { return false }
        return dpData.appId == appId || surfaceMsg.surfaceId.contains(appId)
    }

    /// Open an app in the workspace view (main content area).
    private func openAppInWorkspace(app: AppListManager.AppItem) {
        appListManager.recordAppOpen(
            id: app.id,
            name: app.name,
            icon: app.icon,
            previewBase64: app.previewBase64,
            appType: app.appType
        )
        try? daemonClient.sendAppOpen(appId: app.id)
    }

    // MARK: - Drawer Drag Helpers

    private func resetDrawerDragState() {
        isDrawerDragging = false
        drawerDragStartWidth = nil
        drawerDragStartAvailableWidth = nil
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
                        // Capture initial state on first drag event. Check both nil state AND
                        // isDrawerDragging flag to handle race condition where async reset hasn't completed.
                        if drawerDragStartWidth == nil || !isDrawerDragging {
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
                        let minDrawerWidth: CGFloat = 200
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
                            threadDrawerWidth = min(max(newWidth, minDrawerWidth), maxAllowed)
                        }
                    }
                    .onEnded { _ in
                        resetDrawerDragState()
                    }
            )
            .onDisappear {
                resetDrawerDragState()
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
                    onClose: { windowState.selection = nil }
                )
            }
        case .settings:
            SettingsPanel(onClose: { windowState.selection = nil }, store: settingsStore, daemonClient: daemonClient, threadManager: threadManager)
        case .agent:
            AgentPanel(onClose: { windowState.selection = nil }, onInvokeSkill: { skill in
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
                windowState.selection = nil
            }, daemonClient: daemonClient)
        case .debug:
            DebugPanel(
                traceStore: traceStore,
                daemonClient: daemonClient,
                activeSessionId: threadManager.activeViewModel?.sessionId,
                onClose: { windowState.selection = nil }
            )
        case .doctor:
            DoctorPanel(onClose: { windowState.selection = nil })
        case .directory:
            AppDirectoryView(
                daemonClient: daemonClient,
                onBack: { windowState.selection = nil },
                onOpenApp: { surfaceMsg in
                    windowState.activeDynamicSurface = surfaceMsg
                    windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                    if let surface = windowState.activeDynamicParsedSurface,
                       case .dynamicPage(let dpData) = surface.data,
                       let appId = dpData.appId {
                        windowState.selection = .app(appId)
                    } else {
                        windowState.selection = .app(surfaceMsg.surfaceId)
                    }
                },
                onRecordAppOpen: { id, name, icon, appType in
                    appListManager.recordAppOpen(id: id, name: name, icon: icon, appType: appType)
                },
                onPinApp: { id, name, icon, appType in
                    appListManager.recordAppOpen(id: id, name: name, icon: icon, appType: appType)
                    appListManager.pinApp(id: id)
                }
            )
        case .generated:
            GeneratedPanel(
                onClose: { showSharePicker = false; windowState.closeDynamicPanel() },
                isExpanded: Binding(
                    get: { windowState.isDynamicExpanded },
                    set: { windowState.isDynamicExpanded = $0 }
                ),
                daemonClient: daemonClient,
                onOpenApp: { surfaceMsg in
                    windowState.activeDynamicSurface = surfaceMsg
                    windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                },
                onRecordAppOpen: { id, name, icon, appType in
                    appListManager.recordAppOpen(id: id, name: name, icon: icon, appType: appType)
                }
            )
        case .threadList:
            sidebarView
        case .identity:
            IdentityPanel(onClose: { windowState.selection = nil }, daemonClient: daemonClient)
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
                        let appId = dpData.appId ?? surfaceId
                        if let threadId = threadManager.activeThreadId {
                            windowState.setAppEditing(appId: appId, threadId: threadId)
                        }
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
        switch windowState.selection {
        case .thread:
            // Show chat for this thread (threadManager.activeViewModel is synced)
            defaultChatLayout
        case .app:
            // App workspace: full width (no chat dock), wrapped in rounded container
            if let surface = windowState.activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data {
                dynamicWorkspaceView(surface: surface, data: dpData)
                    .background(VColor.backgroundSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .padding(VSpacing.sm)
            } else {
                // Gallery mode fallback
                GeneratedPanel(
                    onClose: { showSharePicker = false; windowState.closeDynamicPanel() },
                    isExpanded: Binding(
                        get: { windowState.isDynamicExpanded },
                        set: { windowState.isDynamicExpanded = $0 }
                    ),
                    daemonClient: daemonClient,
                    onOpenApp: { surfaceMsg in
                        windowState.activeDynamicSurface = surfaceMsg
                        windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                    },
                    onRecordAppOpen: { id, name, icon, appType in
                        appListManager.recordAppOpen(id: id, name: name, icon: icon, appType: appType)
                    }
                )
            }
        case .appEditing:
            // VSplitView: ChatView (left) + workspace (right)
            if let surface = windowState.activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data {
                VSplitView(
                    panelWidth: $sidePanelWidth,
                    showPanel: true,
                    main: {
                        chatView
                    },
                    panel: {
                        dynamicWorkspaceView(surface: surface, data: dpData)
                    }
                )
            } else {
                defaultChatLayout
            }
        case .panel(let panelType):
            if panelType == .directory {
                AppDirectoryView(
                    daemonClient: daemonClient,
                    onBack: { windowState.dismissOverlay() },
                    onOpenApp: { surfaceMsg in
                        windowState.activeDynamicSurface = surfaceMsg
                        windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                        if let surface = windowState.activeDynamicParsedSurface,
                           case .dynamicPage(let dpData) = surface.data,
                           let appId = dpData.appId {
                            windowState.selection = .app(appId)
                        } else {
                            windowState.selection = .app(surfaceMsg.surfaceId)
                        }
                    },
                    onRecordAppOpen: { id, name, icon, appType in
                        appListManager.recordAppOpen(id: id, name: name, icon: icon, appType: appType)
                    },
                    onPinApp: { id, name, icon, appType in
                        appListManager.recordAppOpen(id: id, name: name, icon: icon, appType: appType)
                        appListManager.pinApp(id: id)
                    }
                )
                .overlay(alignment: .topTrailing) { panelDismissButton }
            } else if panelType == .activity {
                // Activity panel shown as side panel alongside chat
                let config = windowState.layoutConfig
                let showActivity = threadManager.activeViewModel != nil
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
                                onClose: { windowState.selection = nil }
                            )
                        } else {
                            slotView(for: config.right.content)
                        }
                    }
                )
            } else if panelType == .documentEditor {
                let config = windowState.layoutConfig
                VSplitView(
                    panelWidth: $sidePanelWidth,
                    showPanel: documentManager.hasActiveDocument,
                    main: { slotView(for: config.center.content) },
                    panel: {
                        DocumentEditorPanelView(
                            documentManager: documentManager,
                            daemonClient: daemonClient,
                            onClose: { windowState.selection = nil; documentManager.closeDocument() }
                        )
                    }
                )
            } else {
                // Full-window panels: settings, skills, debug, doctor, identity
                fullWindowPanel(panelType)
            }
        case nil:
            // Default: show chat for active thread
            defaultChatLayout
        }
    }

    /// The default chat layout used when showing a thread or no specific selection.
    @ViewBuilder
    private var defaultChatLayout: some View {
        let config = windowState.layoutConfig
        let showConfigPanel = config.right.visible && config.right.content != .empty

        VSplitView(
            panelWidth: $sidePanelWidth,
            showPanel: showConfigPanel,
            main: { slotView(for: config.center.content) },
            panel: {
                slotView(for: config.right.content)
            }
        )
    }

    @ViewBuilder
    private var chatView: some View {
        if let viewModel = threadManager.activeViewModel {
            ActiveChatViewWrapper(
                viewModel: viewModel,
                windowState: windowState,
                daemonClient: daemonClient,
                ambientAgent: ambientAgent,
                settingsStore: settingsStore,
                onMicrophoneToggle: onMicrophoneToggle,
                isTemporaryChat: threadManager.activeThread?.kind == .private
            )
            .overlay(alignment: .bottomTrailing) {
                DemoOverlayView()
            }
        }
    }

    @ViewBuilder
    private func fullWindowPanel(_ panel: SidePanelType) -> some View {
        switch panel {
        case .settings:
            SettingsPanel(onClose: { windowState.dismissOverlay() }, store: settingsStore, daemonClient: daemonClient, threadManager: threadManager)
                .overlay(alignment: .topTrailing) { panelDismissButton }
        case .agent:
            AgentPanel(onClose: { windowState.dismissOverlay() }, onInvokeSkill: { skill in
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
                windowState.dismissOverlay()
            }, daemonClient: daemonClient)
                .overlay(alignment: .topTrailing) { panelDismissButton }
        case .debug:
            DebugPanel(
                traceStore: traceStore,
                daemonClient: daemonClient,
                activeSessionId: threadManager.activeViewModel?.sessionId,
                onClose: { windowState.dismissOverlay() }
            )
            .overlay(alignment: .topTrailing) { panelDismissButton }
        case .doctor:
            DoctorPanel(onClose: { windowState.dismissOverlay() })
                .overlay(alignment: .topTrailing) { panelDismissButton }
        case .identity:
            IdentityPanel(onClose: { windowState.dismissOverlay() }, daemonClient: daemonClient)
                .overlay(alignment: .topTrailing) { panelDismissButton }
        case .generated:
            // Generated panel is handled inline in chatContentView when expanded;
            // if we reach here, isDynamicExpanded is false — clear selection so
            // the user falls back to the chat view instead of seeing a blank screen.
            Color.clear.frame(width: 0, height: 0)
                .onAppear { windowState.dismissOverlay() }
        case .documentEditor:
            // Document editor is handled inline in chatContentView
            EmptyView()
                .onAppear { windowState.dismissOverlay() }
        default:
            EmptyView()
        }
    }

    /// Consistent X close button for panel overlays.
    private var panelDismissButton: some View {
        Button(action: { windowState.dismissOverlay() }) {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(VColor.textSecondary)
                .frame(width: 28, height: 28)
                .background(VColor.surface.opacity(0.8))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .padding(.top, VSpacing.lg)
        .padding(.trailing, VSpacing.lg)
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
                isSidebarOpen: sidebarOpen,
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
                onToggleChatDock: {
                    if case .appEditing(let appId, _) = windowState.selection {
                        // Toggle off: go back to full-screen app view
                        windowState.selection = .app(appId)
                    } else if case .app(let appId) = windowState.selection {
                        // Toggle on: find most recent thread and enter editing mode
                        let threadId = threadManager.activeThreadId ?? threadManager.visibleThreads.first?.id
                        if let threadId {
                            threadManager.selectThread(id: threadId)
                            windowState.setAppEditing(appId: appId, threadId: threadId)
                        }
                    }
                },
                onMicrophoneToggle: onMicrophoneToggle
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

private struct SidebarSectionHeader<Trailing: View>: View {
    let title: String
    let trailing: Trailing

    init(title: String, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack {
            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)
                .textCase(.uppercase)
            Spacer()
            trailing
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.bottom, VSpacing.xs)
    }
}

extension SidebarSectionHeader where Trailing == EmptyView {
    init(title: String) {
        self.title = title
        self.trailing = EmptyView()
    }
}

private struct NewConversationButton: View {
    let action: () -> Void

    var body: some View {
        VButton(label: "New", icon: "plus", style: .primary, action: action)
            .controlSize(.small)
    }
}

private struct ControlCenterMenuButton: View {
    let isOpen: Bool
    let onToggle: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button {
            onToggle()
        } label: {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "gearshape")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isOpen ? VColor.textPrimary : VColor.textSecondary)

                Text("Control Center")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isOpen ? VColor.textPrimary : VColor.textSecondary)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                Capsule()
                    .fill(isHovered || isOpen ? VColor.hoverOverlay.opacity(0.08) : VColor.backgroundSubtle)
                    .overlay(
                        Capsule()
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
            )
            .contentShape(Capsule())
            .onHover { hovering in
                isHovered = hovering
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
        }
        .buttonStyle(.plain)
    }
}

private struct DrawerMenuView: View {
    let onIdentity: () -> Void
    let onSkills: () -> Void
    let onSettings: () -> Void
    let onDebug: () -> Void
    let onDoctor: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DrawerMenuItem(icon: "person.crop.circle", label: "Identity", action: onIdentity)
            DrawerMenuItem(icon: "wand.and.stars", label: "Skills", action: onSkills)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            DrawerMenuItem(icon: "gearshape", label: "Settings", action: onSettings)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            DrawerMenuItem(icon: "ladybug", label: "Debug", action: onDebug)
            DrawerMenuItem(icon: "stethoscope", label: "Vellum Doctor", action: onDoctor)
        }
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.3), radius: 12, x: 4)
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
    let daemonClient: DaemonClient
    let ambientAgent: AmbientAgent
    @ObservedObject var settingsStore: SettingsStore
    let onMicrophoneToggle: () -> Void
    var isTemporaryChat: Bool = false

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
                windowState.selection = .panel(.settings)
            },
            onSend: viewModel.sendMessage,
            onStop: viewModel.stopGenerating,
            onDismissError: viewModel.dismissError,
            isRetryableError: viewModel.isRetryableError,
            onRetryError: { viewModel.retryLastMessage() },
            isSecretBlockError: viewModel.isSecretBlockError,
            onSendAnyway: { viewModel.sendAnyway() },
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
            onModelPickerSelect: { messageId, modelId in
                settingsStore.setModel(modelId)
            },
            selectedModel: settingsStore.selectedModel,
            configuredProviders: settingsStore.configuredProviders,
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
            isActivityPanelOpen: { if case .panel(.activity) = windowState.selection { return true } else { return false } }(),
            onReportMessage: { daemonMessageId in
                guard let sessionId = viewModel.sessionId else { return }
                do {
                    try daemonClient.sendDiagnosticsExportRequest(
                        conversationId: sessionId,
                        anchorMessageId: daemonMessageId
                    )
                } catch {
                    windowState.showToast(
                        message: "Failed to request report export.",
                        style: .error
                    )
                }
            },
            mediaEmbedSettings: MediaEmbedResolverSettings(
                enabled: settingsStore.mediaEmbedsEnabled,
                enabledSince: settingsStore.mediaEmbedsEnabledSince,
                allowedDomains: settingsStore.mediaEmbedVideoAllowlistDomains
            ),
            isTemporaryChat: isTemporaryChat
        )
    }
}

// MARK: - Ghost Button

/// A borderless button with a rounded-rectangle outline, monospace font, and subtle hover fill.
private struct GhostButton: View {
    let label: String
    let icon: String?
    let action: () -> Void

    @State private var isHovered = false

    init(_ label: String, icon: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.icon = icon
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 11, weight: .medium))
                }
                if !label.isEmpty {
                    Text(label)
                        .font(VFont.monoSmall)
                }
            }
            .foregroundColor(VColor.textSecondary)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(isHovered ? VColor.backgroundSubtle : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
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
    let isSidebarOpen: Bool
    @Binding var isPublishing: Bool
    @Binding var publishedUrl: String?
    @Binding var publishError: String?
    @Binding var isBundling: Bool
    @Binding var showSharePicker: Bool
    @Binding var shareFileURL: URL?
    @Binding var workspaceEditorContentHeight: CGFloat
    let onPublishPage: (String, String?, String?) -> Void
    let onBundleAndShare: (String) -> Void
    let isChatDockOpen: Bool
    let onToggleChatDock: () -> Void
    let onMicrophoneToggle: () -> Void

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
                bottomContentInset: 0
            )

            VStack(spacing: 0) {
                HStack {
                    // Left: Done Editing primary CTA in edit mode, Edit ghost button otherwise
                    if case .appEditing = windowState.selection {
                        VButton(label: "Done Editing", style: .primary) {
                            onToggleChatDock()
                        }
                        .controlSize(.small)
                    } else {
                        VButton(label: "Edit", icon: "pencil", style: .ghost) {
                            if !isChatDockOpen {
                                windowState.workspaceComposerExpanded = false
                            }
                            onToggleChatDock()
                        }
                        .controlSize(.small)
                        .accessibilityLabel("Edit app")
                    }

                    Spacer()

                    // Center: App name
                    if let title = data.preview?.title {
                        Text(title)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    Spacer()

                    // Right: Share + Close ghost buttons
                    HStack(spacing: VSpacing.sm) {
                        if isPublishing {
                            ProgressView()
                                .controlSize(.small)
                                .frame(height: 24)
                        } else if let url = publishedUrl {
                            VButton(label: "Copied!", icon: "checkmark", style: .ghost) {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(url, forType: .string)
                            }
                            .controlSize(.small)
                        } else {
                            VButton(label: "Publish", icon: "arrow.up.right", style: .ghost) {
                                onPublishPage(data.html, data.preview?.title, data.appId)
                            }
                            .controlSize(.small)
                        }

                        VButton(label: "X", style: .ghost) {
                            showSharePicker = false
                            windowState.activeDynamicSurface = nil
                            windowState.activeDynamicParsedSurface = nil
                            windowState.dismissOverlay()
                        }
                        .controlSize(.small)
                        .accessibilityLabel("Close workspace")
                    }
                }
                .padding(.leading, (isSidebarOpen || isChatDockOpen) ? VSpacing.lg : trafficLightPadding)
                .padding(.trailing, VSpacing.xl)
                .padding(.top, VSpacing.md)

                if let error = publishError {
                    HStack {
                        Spacer()
                        Text(error)
                            .font(VFont.caption)
                            .foregroundColor(VColor.error)
                            .padding(.horizontal, VSpacing.md)
                            .padding(.vertical, VSpacing.xs)
                            .background(Rose._900.opacity(0.8))
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .padding(.trailing, VSpacing.xl)
                    }
                }

                Spacer()
            }
        }
    }
}

struct MainWindowView_Previews: PreviewProvider {
    static var previews: some View {
        let dc = DaemonClient()
        MainWindowView(threadManager: ThreadManager(daemonClient: dc), appListManager: AppListManager(), zoomManager: ZoomManager(), traceStore: TraceStore(), daemonClient: dc, surfaceManager: SurfaceManager(), ambientAgent: AmbientAgent(), settingsStore: SettingsStore(daemonClient: dc), windowState: MainWindowState(), documentManager: DocumentManager())
            .frame(width: 900, height: 600)
            .padding(.top, 36)
    }
}
