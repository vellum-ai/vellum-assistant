import Combine
import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var appListManager: AppListManager
    var zoomManager: ZoomManager
    var conversationZoomManager: ConversationZoomManager
    /// Plain `let` instead of `@ObservedObject` so SwiftUI doesn't observe
    /// TraceStore mutations when the DebugPanel isn't visible. DebugPanel
    /// itself uses `@ObservedObject` and is only instantiated when shown.
    let traceStore: TraceStore
    let usageDashboardStore: UsageDashboardStore
    @ObservedObject var windowState: MainWindowState
    @State private var selectedThreadId: UUID?
    @State var sharing = SharingState()
    @State var sidebar = SidebarInteractionState()
    @AppStorage("isAppChatOpen") var isAppChatOpen: Bool = false
    @State private var jitPermissionManager = JITPermissionManager()
    @State var showThreadActionsDrawer = false
    /// Frame of the thread title button in the coordinate space of coreLayoutView,
    /// used to position the actions drawer directly below it.
    @State private var threadTitleFrame: CGRect = .zero
    /// Stores the thread ID the user was on before entering temporary chat,
    /// so we can restore it when they exit instead of jumping to visibleThreads.first
    /// (which may be a pinned thread unrelated to what they were doing).
    @State private var preTemporaryChatThreadId: UUID?

    @AppStorage("sidebarExpanded") var sidebarExpanded: Bool = true
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var systemIsDark: Bool = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    let sidebarExpandedWidth: CGFloat = 240
    let sidebarCollapsedWidth: CGFloat = 52
    @AppStorage("sidePanelWidth") var sidePanelWidth: Double = 400
    @AppStorage("appPanelWidth") var appPanelWidth: Double = -1
    @AppStorage("appChatDockWidth") var appChatDockWidth: Double = -1
    let daemonClient: DaemonClient
    let surfaceManager: SurfaceManager
    let ambientAgent: AmbientAgent
    let settingsStore: SettingsStore
    let authManager: AuthManager
    @ObservedObject var documentManager: DocumentManager
    let onMicrophoneToggle: () -> Void
    @ObservedObject var voiceModeManager: VoiceModeManager

    /// Callback to send the wake-up greeting after the "coming alive" transition.
    /// Nil for returning users (no transition).
    let onSendWakeUp: (() -> Void)?

    @State var showThreadSwitcher = false
    @State var threadSwitcherTriggerFrame: CGRect = .zero
    /// Whether the "coming alive" overlay is currently showing.
    @State private var showComingAlive: Bool
    /// Whether the daemon-loading skeleton overlay is currently showing.
    @State var showDaemonLoading: Bool

    init(threadManager: ThreadManager, appListManager: AppListManager, zoomManager: ZoomManager, conversationZoomManager: ConversationZoomManager, traceStore: TraceStore, usageDashboardStore: UsageDashboardStore, daemonClient: DaemonClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, settingsStore: SettingsStore, authManager: AuthManager, windowState: MainWindowState, documentManager: DocumentManager, onMicrophoneToggle: @escaping () -> Void = {}, voiceModeManager: VoiceModeManager, onSendWakeUp: (() -> Void)? = nil) {
        self.threadManager = threadManager
        self.appListManager = appListManager
        self.zoomManager = zoomManager
        self.conversationZoomManager = conversationZoomManager
        self.traceStore = traceStore
        self.usageDashboardStore = usageDashboardStore
        self.daemonClient = daemonClient
        self.surfaceManager = surfaceManager
        self.ambientAgent = ambientAgent
        self.settingsStore = settingsStore
        self.authManager = authManager
        self.windowState = windowState
        self.documentManager = documentManager
        self.onMicrophoneToggle = onMicrophoneToggle
        self.voiceModeManager = voiceModeManager
        self.onSendWakeUp = onSendWakeUp
        self._showComingAlive = State(initialValue: onSendWakeUp != nil)
        // Show skeleton loading only for normal launches (not post-onboarding where
        // ComingAliveOverlay handles the transition).
        self._showDaemonLoading = State(initialValue: onSendWakeUp == nil)
    }

    // MARK: - Layout Constants

    /// Leading padding to account for macOS traffic light buttons (red/yellow/green).
    /// Note: This is a fixed value that may not be accurate for all window styles or
    /// if Apple changes the traffic light spacing. Dynamic measurement would be better
    /// but requires complex window geometry inspection.
    let trafficLightPadding: CGFloat = 78

    /// When a generated surface is expanded into the workspace, hide the
    /// global sidebar toggle so workspace controls own the top-left slot.
    private var isGeneratedWorkspaceOpen: Bool {
        windowState.isDynamicExpanded && windowState.activePanel == .generated
    }

    /// Whether the BOOTSTRAP.md first-run ritual is still in progress.
    /// When true, the client shows a chat-only interface — no Home Base dashboard.
    private var isBootstrapOnboardingActive: Bool {
        FileManager.default.fileExists(atPath: NSHomeDirectory() + "/.vellum/workspace/BOOTSTRAP.md")
    }

    private func toggleVoiceMode() {
        if voiceModeManager.state != .off {
            voiceModeManager.deactivate()
        } else {
            // Ensure a thread exists
            if threadManager.activeViewModel == nil {
                threadManager.enterDraftMode()
            }
            // Activate directly — voice bar appears automatically via ComposerSection
            if let viewModel = threadManager.activeViewModel {
                voiceModeManager.activate(chatViewModel: viewModel, settingsStore: settingsStore)
                voiceModeManager.startListening()
            }
        }
    }

    private func toggleTemporaryChat() {
        withAnimation(VAnimation.standard) {
            if threadManager.activeThread?.kind == .private {
                // Restore the thread the user was on before entering temporary chat.
                // Fall back to visibleThreads.first only if the stored thread no longer exists.
                if let savedId = preTemporaryChatThreadId,
                   threadManager.visibleThreads.contains(where: { $0.id == savedId }) {
                    threadManager.selectThread(id: savedId)
                } else if let recent = threadManager.visibleThreads.first {
                    threadManager.selectThread(id: recent.id)
                } else {
                    threadManager.enterDraftMode()
                }
                preTemporaryChatThreadId = nil
            } else {
                preTemporaryChatThreadId = threadManager.activeThreadId
                threadManager.createPrivateThread()
            }
        }
    }

    /// Resolve a thread ID for the chat bubble toggle using strict priority:
    /// 1. activeThreadId (currently selected thread)
    /// 2. persistentThreadId (app's last-used thread)
    /// 3. visibleThreads.first (first available thread)
    /// 4. create a new thread
    private func resolveThreadId() -> UUID {
        if let id = threadManager.activeThreadId { return id }
        if let id = windowState.persistentThreadId { return id }
        if let id = threadManager.visibleThreads.first?.id { return id }
        threadManager.createThread()
        return threadManager.activeThreadId!
    }

    func enterAppEditing(appId: String) {
        let threadId = resolveThreadId()
        threadManager.selectThread(id: threadId)
        windowState.setAppEditing(appId: appId, threadId: threadId)
    }

    func exitAppEditing(appId: String) {
        windowState.selection = .app(appId)
    }

    /// Whether the chat bubble toggle is active (chat is open).
    var isChatBubbleActive: Bool {
        switch windowState.selection {
        case .appEditing:
            return true
        case .panel(let panelType) where panelType != .documentEditor:
            return isAppChatOpen
        default:
            return false
        }
    }


    /// Resolve display names for thread export.
    private func resolveParticipantNames() -> ChatTranscriptFormatter.ParticipantNames {
        let assistantName = AssistantDisplayName.resolve(
            IdentityInfo.load()?.name,
            fallback: AssistantDisplayName.placeholder
        )

        // User name: stored profile → system name → fallback
        let userName: String = {
            if let data = UserDefaults.standard.data(forKey: "user.profile"),
               let profile = try? JSONDecoder().decode(UserProfile.self, from: data),
               let name = profile.name, !name.isEmpty {
                return name
            }
            let fullName = NSFullUserName()
            if !fullName.isEmpty { return fullName }
            return "User"
        }()

        return ChatTranscriptFormatter.ParticipantNames(
            assistantName: assistantName,
            userName: userName
        )
    }

    func copyActiveThreadToClipboard() {
        let messages = threadManager.activeViewModel?.messages ?? []
        let title = threadManager.activeThread?.title
        let names = resolveParticipantNames()
        let markdown = ChatTranscriptFormatter.threadMarkdown(
            messages: messages,
            threadTitle: title,
            participantNames: names
        )
        guard !markdown.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown, forType: .string)
        windowState.showToast(message: "Thread copied to clipboard", style: .success)
    }

    private var threadHeaderPresentation: ThreadHeaderPresentation {
        ThreadHeaderPresentation(
            activeThread: threadManager.activeThread,
            activeViewModel: threadManager.activeViewModel,
            isConversationVisible: windowState.isShowingChat || isChatBubbleActive
        )
    }

    func dismissThreadDrawer() {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
            showThreadActionsDrawer = false
        }
    }

    func startRenameActiveThread() {
        guard let id = threadManager.activeThreadId,
              let thread = threadManager.activeThread else { return }
        sidebar.renamingThreadId = id
        sidebar.renameText = thread.title
    }

    var body: some View {
        coreLayoutView
            .opacity(showComingAlive ? 0 : 1)
            .overlay {
                if showComingAlive {
                    ComingAliveOverlay(onComplete: {
                        withAnimation(VAnimation.standard) {
                            showComingAlive = false
                        }
                        // Send the wake-up message after the chat fades in
                        DispatchQueue.main.asyncAfter(deadline: .now() + VAnimation.durationStandard) {
                            onSendWakeUp?()
                        }
                    })
                    .transition(.opacity)
                }
            }
            .onChange(of: threadManager.activeThreadId) { oldId, newId in
                // Deactivate voice mode on a real thread switch (UUID → different UUID),
                // but not on draft promotion (nil → UUID) which happens on first send.
                if let oldId, oldId != newId, voiceModeManager.state != .off {
                    voiceModeManager.deactivate()
                }
                // Dismiss thread actions drawer on thread switch
                if showThreadActionsDrawer {
                    showThreadActionsDrawer = false
                }
            }
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
                    sharing.showSharePicker = false
                    windowState.activeDynamicSurface = nil
                    windowState.activeDynamicParsedSurface = nil
                }

                // Reset publish state when switching to a different app so new/different
                // apps don't inherit the "Published" badge from a previously published app.
                let oldAppId: String? = {
                    switch oldSelection {
                    case .app(let id): return id
                    case .appEditing(let id, _): return id
                    default: return nil
                    }
                }()
                let newAppId: String? = {
                    switch newSelection {
                    case .app(let id): return id
                    case .appEditing(let id, _): return id
                    default: return nil
                    }
                }()
                if oldAppId != newAppId {
                    sharing.publishedUrl = nil
                    sharing.publishError = nil
                }

                // Collapse the sidebar when an app opens to avoid crowding
                if sidebarExpanded {
                    let shouldCollapse: Bool = {
                        switch newSelection {
                        case .app, .appEditing: return true
                        default: return false
                        }
                    }()
                    if shouldCollapse {
                        withAnimation(VAnimation.panel) {
                            sidebarExpanded = false
                        }
                    }
                }
            }
            .onChange(of: windowState.activeDynamicSurface?.surfaceId) { _, surfaceId in
                if windowState.isDynamicExpanded {
                    threadManager.activeViewModel?.activeSurfaceId = surfaceId
                }
            }
            .preferredColorScheme(themePreference == "light" ? .light : themePreference == "dark" ? .dark : systemIsDark ? .dark : .light)
            .onReceive(DistributedNotificationCenter.default().publisher(for: Notification.Name("AppleInterfaceThemeChangedNotification"))) { _ in
                systemIsDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            }
    }

    private var isSettingsOpen: Bool {
        if case .panel(.settings) = windowState.selection { return true }
        return false
    }

    /// Top bar extracted to break up type-checker complexity.
    private var topBarView: some View {
        HStack(spacing: VSpacing.sm) {
            if !isSettingsOpen {
                VIconButton(label: "Sidebar", icon: "sidebar.left", iconOnly: true, tooltip: sidebarExpanded ? "Collapse sidebar" : "Expand sidebar") {
                    withAnimation(VAnimation.panel) {
                        sidebarExpanded.toggle()
                    }
                }

                Button {
                    AppDelegate.shared?.toggleCommandPalette()
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._400))
                        VShortcutTag("\u{2318}K")
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Search (\u{2318}K)")
            }
            Spacer()
            if windowState.isShowingChat || isChatBubbleActive {
                ThreadTitleActionsControl(
                    presentation: threadHeaderPresentation,
                    onCopy: { copyActiveThreadToClipboard(); dismissThreadDrawer() },
                    onPin: {
                        guard let id = threadManager.activeThreadId else { return }
                        threadManager.pinThread(id: id)
                        dismissThreadDrawer()
                    },
                    onUnpin: {
                        guard let id = threadManager.activeThreadId else { return }
                        threadManager.unpinThread(id: id)
                        dismissThreadDrawer()
                    },
                    onArchive: {
                        guard let id = threadManager.activeThreadId else { return }
                        threadManager.archiveThread(id: id)
                        dismissThreadDrawer()
                    },
                    onRename: { startRenameActiveThread(); dismissThreadDrawer() },
                    showDrawer: $showThreadActionsDrawer
                )
                .background(GeometryReader { proxy in
                    Color.clear.onAppear {
                        threadTitleFrame = proxy.frame(in: .named("coreLayout"))
                    }
                    .onChange(of: proxy.frame(in: .named("coreLayout"))) { _, newFrame in
                        threadTitleFrame = newFrame
                    }
                })
            }
            Spacer()
            PTTKeyIndicator {
                settingsStore.pendingSettingsTab = .voice
                windowState.selection = .panel(.settings)
            }
            if windowState.isShowingChat || isChatBubbleActive {
                // Voice mode toggle
                VIconButton(
                    label: "Voice Mode",
                    icon: voiceModeManager.state != .off ? "waveform.circle.fill" : "waveform.circle",
                    isActive: voiceModeManager.state != .off,
                    iconOnly: true,
                    tooltip: voiceModeManager.state != .off ? "Exit voice mode" : "Voice mode"
                ) {
                    toggleVoiceMode()
                }

                // Temporary chat toggle — always visible on private threads (so users can exit temp chat),
                // only visible on normal threads when no messages exist yet
                if threadManager.activeThread?.kind == .private || threadManager.activeViewModel?.messages.contains(where: {
                    !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }) != true {
                    TemporaryChatToggle(
                        isActive: threadManager.activeThread?.kind == .private,
                        tooltip: threadManager.activeThread?.kind == .private ? "Exit temporary chat" : "Temporary chat",
                        onToggle: { toggleTemporaryChat() }
                    )
                }
            }
        }
        .padding(.leading, trafficLightPadding)
        .padding(.trailing, VSpacing.lg)
        .frame(height: 36)
        .background(adaptiveColor(light: Moss._50, dark: Moss._950))
    }

    /// Core layout extracted to break up type-checker complexity.
    private var coreLayoutView: some View {
        GeometryReader { geometry in
            Group {
                VStack(spacing: 0) {
                    topBarView

                    // Main container: sidebar + content with uniform padding
                    HStack(spacing: 16) {
                        if !isSettingsOpen {
                            sidebarView
                                .animation(VAnimation.panel, value: sidebarExpanded)
                        }

                        chatContentView(geometry: geometry)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                            .animation(nil, value: sidebarExpanded)
                            .overlay {
                                if showDaemonLoading {
                                    DaemonLoadingChatSkeleton()
                                        .transition(.opacity)
                                }
                            }
                    }
                    .padding(16)
                }
                .coordinateSpace(name: "coreLayout")
                .overlay {
                    // Click-outside-to-dismiss background for preferences drawer
                    if sidebar.showPreferencesDrawer {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture {
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                                    sidebar.showPreferencesDrawer = false
                                }
                            }
                    }
                }
                .overlay {
                    // Click-outside-to-dismiss background for thread actions drawer
                    if showThreadActionsDrawer {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { dismissThreadDrawer() }
                    }
                }
                .overlay(alignment: .topLeading) {
                    if showThreadActionsDrawer {
                        let presentation = threadHeaderPresentation
                        ThreadActionsDrawer(
                            presentation: presentation,
                            onCopy: { copyActiveThreadToClipboard(); dismissThreadDrawer() },
                            onPin: {
                                guard let id = threadManager.activeThreadId else { return }
                                threadManager.pinThread(id: id)
                                dismissThreadDrawer()
                            },
                            onUnpin: {
                                guard let id = threadManager.activeThreadId else { return }
                                threadManager.unpinThread(id: id)
                                dismissThreadDrawer()
                            },
                            onArchive: {
                                guard let id = threadManager.activeThreadId else { return }
                                threadManager.archiveThread(id: id)
                                dismissThreadDrawer()
                            },
                            onRename: { startRenameActiveThread(); dismissThreadDrawer() }
                        )
                        .offset(x: threadTitleFrame.minX, y: threadTitleFrame.maxY)
                        .zIndex(10)
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    // Preferences drawer rendered at top level so it floats above all content
                    if sidebar.showPreferencesDrawer {
                        let drawerWidth = sidebarExpandedWidth - VSpacing.sm * 2
                        let sidebarWidth = sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth
                        let drawerX = 16 + sidebarWidth - VSpacing.xs
                        DrawerMenuView(
                            onSettings: {
                                sidebar.showPreferencesDrawer = false
                                windowState.selection = .panel(.settings)
                            },
                            onUsage: {
                                sidebar.showPreferencesDrawer = false
                                windowState.selection = .panel(.usageDashboard)
                            },
                            onDebug: {
                                sidebar.showPreferencesDrawer = false
                                windowState.selection = .panel(.debug)
                            },
                            onLogOut: {
                                sidebar.showPreferencesDrawer = false
                                AppDelegate.shared?.performLogout()
                            }
                        )
                        .frame(width: drawerWidth)
                        .offset(x: drawerX, y: -28)
                        .zIndex(10)
                        .transition(.opacity)
                    }
                }
                .overlay {
                    if showThreadSwitcher {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture {
                                showThreadSwitcher = false
                            }
                    }
                }
                .overlay(alignment: .topLeading) {
                    if showThreadSwitcher {
                        ThreadSwitcherDrawer(
                            regularThreads: regularThreads,
                            activeThreadId: threadManager.activeThreadId,
                            threadManager: threadManager,
                            windowState: windowState,
                            sidebar: sidebar,
                            selectThread: { selectThread($0) },
                            onDismiss: { showThreadSwitcher = false }
                        )
                        .frame(width: sidebarExpandedWidth - VSpacing.sm * 2)
                        .offset(
                            x: 16 + sidebarCollapsedWidth - VSpacing.xs,
                            y: threadSwitcherTriggerFrame.minY
                        )
                        .zIndex(10)
                        .transition(.opacity)
                        .onChange(of: threadManager.activeThreadId) { _, _ in
                            showThreadSwitcher = false
                        }
                        .onChange(of: sidebarExpanded) { _, expanded in
                            if expanded { showThreadSwitcher = false }
                        }
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
                    style: toast.style == .success ? .success : toast.style == .warning ? .warning : .error,
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
            // Reset stale chat-dock state for users upgrading from versions
            // that had the ChatBubbleToggle (now removed). Without this,
            // isAppChatOpen could remain persisted as true with no UI to
            // disable it, leaving panels stuck in split mode.
            isAppChatOpen = false
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
            selectedThreadId = threadManager.activeThreadId
            // Initialize persistent thread tracking on launch
            if let activeId = threadManager.activeThreadId {
                windowState.persistentThreadId = activeId
            }
            daemonClient.startSSE()
        }
        .onDisappear {
            sharing.errorDismissTask?.cancel()
            sharing.errorDismissTask = nil
            sharing.credentialPollTimer?.invalidate()
            sharing.credentialPollTimer = nil
            sharing.pendingPublish = nil
            if let handler = sharing.previousVercelHandler {
                daemonClient.onVercelApiConfigResponse = handler
                sharing.previousVercelHandler = nil
            }
            daemonClient.stopSSE()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
        }
        .onReceive(daemonClient.$isConnected) { connected in
            windowState.refreshAPIKeyStatus(isConnected: connected)

            // Fallback for fresh users with 0 threads: dismiss skeleton after a
            // short delay once the daemon is connected. Only applies during initial load.
            guard connected, showDaemonLoading else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                guard showDaemonLoading else { return }
                withAnimation(VAnimation.standard) {
                    showDaemonLoading = false
                }
            }
        }
        .onChange(of: threadManager.threads.isEmpty) { _, isEmpty in
            // Dismiss skeleton when threads arrive from daemon
            if !isEmpty && showDaemonLoading {
                withAnimation(VAnimation.standard) {
                    showDaemonLoading = false
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            threadManager.markActiveThreadSeenIfNeeded()
        }
        .onChange(of: selectedThreadId) { _, newId in
            if let newId = newId {
                threadManager.selectThread(id: newId)
            }
        }
        .onChange(of: threadManager.activeThreadId) { oldId, newId in
            // Sync activeThreadId changes back to selectedThreadId to keep sidebar selection in sync
            selectedThreadId = newId
            // Always sync persistentThreadId so the sidebar highlights the
            // correct thread — even when an overlay (.panel, .app) is active.
            // Without this, archiving the active thread while viewing a panel
            // leaves persistentThreadId pointing at the archived (invisible) thread
            // and the sidebar shows no active highlight.
            // Clear it when entering draft mode (nil) so no thread appears active.
            windowState.persistentThreadId = newId
            if case .panel(.intelligence) = windowState.selection {
                windowState.selection = nil
            }
            // Clear subagent detail panel on thread switch
            windowState.selectedSubagentId = nil
            // Clear stale activeSurfaceId on the old thread and sync the new one
            if let oldId {
                threadManager.clearActiveSurface(threadId: oldId)
            }
            threadManager.activeViewModel?.activeSurfaceId = windowState.isDynamicExpanded ? windowState.activeDynamicSurface?.surfaceId : nil
            threadManager.activeViewModel?.isChatDockedToSide = windowState.isDynamicExpanded && windowState.isChatDockOpen
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDynamicWorkspace)) { notification in
            if let msg = notification.userInfo?["surfaceMessage"] as? UiSurfaceShowMessage {
                // Full message from daemon live IPC (AppDelegate path)
                windowState.activeDynamicSurface = msg
                windowState.activeDynamicParsedSurface = Surface.from(msg)
                // Determine the app ID from the surface if available
                if let surface = windowState.activeDynamicParsedSurface,
                   case .dynamicPage(let dpData) = surface.data,
                   let appId = dpData.appId {
                    // Open in view-only mode; user can enter edit mode
                    // via the Edit button in the toolbar.
                    windowState.selection = .app(appId)
                } else {
                    windowState.selection = .app(msg.surfaceId)
                }
            } else if let ref = notification.userInfo?["surfaceRef"] as? SurfaceRef {
                // Lightweight ref from inline surface click — the daemon will
                // send a fresh ui_surface_show via live IPC with the full payload.
                // Use the real appId for the app_open_request when available,
                // because surfaceId is a daemon-generated identifier
                // (e.g. "app-open-<uuid>") that doesn't match any real app.
                let reopenId = ref.appId ?? ref.surfaceId
                windowState.selection = .app(reopenId)
                try? daemonClient.sendAppOpen(appId: reopenId)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .shareAppCloud)) { notification in
            guard let appId = notification.userInfo?["appId"] as? String else { return }
            bundleAndShare(appId: appId)
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDocumentEditor)) { notification in
            guard let surfaceId = notification.userInfo?["documentSurfaceId"] as? String else { return }
            if documentManager.hasActiveDocument && documentManager.surfaceId == surfaceId {
                // Document already in memory — just show the panel
                windowState.selection = .panel(.documentEditor)
            } else {
                // Load from daemon — handleDocumentLoadResponse will open the panel when ready
                try? daemonClient.sendDocumentLoad(surfaceId: surfaceId)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .updateDynamicWorkspace)) { notification in
            if let updated = notification.userInfo?["surface"] as? Surface,
               updated.id == windowState.activeDynamicSurface?.surfaceId {
                windowState.activeDynamicParsedSurface = updated
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .requestAppPreview)) { notification in
            guard let appId = notification.userInfo?["appId"] as? String else { return }
            let html = notification.userInfo?["html"] as? String
            let stream = daemonClient.subscribe()
            do { try daemonClient.sendAppPreview(appId: appId) } catch { return }
            Task { @MainActor in
                for await message in stream {
                    if case .appPreviewResponse(let response) = message,
                       response.appId == appId {
                        if let base64 = response.preview, !base64.isEmpty {
                            NotificationCenter.default.post(
                                name: .appPreviewImageCaptured,
                                object: nil,
                                userInfo: ["appId": appId, "previewImage": base64]
                            )
                        } else if let html = html {
                            // No stored preview — capture one via offscreen WKWebView
                            if let base64 = await OffscreenPreviewCapture.capture(html: html) {
                                try? daemonClient.sendAppUpdatePreview(appId: appId, preview: base64)
                                NotificationCenter.default.post(
                                    name: .appPreviewImageCaptured,
                                    object: nil,
                                    userInfo: ["appId": appId, "previewImage": base64]
                                )
                            }
                        }
                        return
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dismissDynamicWorkspace)) { notification in
            // If a specific surfaceId was dismissed, only clear if it matches.
            if let surfaceId = notification.userInfo?["surfaceId"] as? String {
                if windowState.activeDynamicSurface?.surfaceId == surfaceId {
                    sharing.showSharePicker = false
                    windowState.closeDynamicPanel()
                }
            } else {
                // Bulk dismiss (dismissAll) — only clear if currently showing an app workspace.
                // Avoid kicking the user out of unrelated panels (Settings, Agent, etc.).
                if case .app = windowState.selection {
                    sharing.showSharePicker = false
                    windowState.closeDynamicPanel()
                } else if case .appEditing = windowState.selection {
                    sharing.showSharePicker = false
                    windowState.closeDynamicPanel()
                }
            }
        }
        // Hover→pending-deletion invariant is now owned by
        // SidebarInteractionState.setThreadHover(threadId:hovering:)
    }

}
