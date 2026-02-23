import Combine
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
    @State var workspaceEditorContentHeight: CGFloat = 20
    @State var showSharePicker = false
    @State var isBundling = false
    @State var shareFileURL: URL?
    @State var isPublishing = false
    @State var publishedUrl: String?
    @State var publishError: String?
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
    @State private var showCopyThreadConfirmation = false
    @State private var copyThreadConfirmationTimer: DispatchWorkItem?

    @AppStorage("sidebarExpanded") var sidebarExpanded: Bool = true
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var systemIsDark: Bool = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    private let sidebarExpandedWidth: CGFloat = 240
    private let sidebarCollapsedWidth: CGFloat = 52
    @AppStorage("sidePanelWidth") var sidePanelWidth: Double = 400
    @AppStorage("appPanelWidth") var appPanelWidth: Double = -1
    @AppStorage("homeBaseDashboardDefaultEnabled") private var homeBaseDashboardDefaultEnabled: Bool = false
    @AppStorage("homeBaseDashboardAutoEnabled") private var homeBaseDashboardAutoEnabled: Bool = false
    let daemonClient: DaemonClient
    let surfaceManager: SurfaceManager
    let ambientAgent: AmbientAgent
    let settingsStore: SettingsStore
    @ObservedObject var documentManager: DocumentManager
    let avatarEvolutionState: AvatarEvolutionState?
    @State private var lastAppliedBootstrapTurn: Int = 0
    let onMicrophoneToggle: () -> Void
    @ObservedObject var voiceModeManager: VoiceModeManager

    /// Callback to send the wake-up greeting after the "coming alive" transition.
    /// Nil for returning users (no transition).
    let onSendWakeUp: (() -> Void)?

    /// Whether the "coming alive" overlay is currently showing.
    @State private var showComingAlive: Bool

    init(threadManager: ThreadManager, appListManager: AppListManager, zoomManager: ZoomManager, traceStore: TraceStore, daemonClient: DaemonClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, settingsStore: SettingsStore, windowState: MainWindowState, documentManager: DocumentManager, avatarEvolutionState: AvatarEvolutionState? = nil, onMicrophoneToggle: @escaping () -> Void = {}, voiceModeManager: VoiceModeManager = VoiceModeManager(), onSendWakeUp: (() -> Void)? = nil) {
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
        self.avatarEvolutionState = avatarEvolutionState
        self.onMicrophoneToggle = onMicrophoneToggle
        self.voiceModeManager = voiceModeManager
        self.onSendWakeUp = onSendWakeUp
        self._showComingAlive = State(initialValue: onSendWakeUp != nil)
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

    private func pageURL(for appId: String) -> URL? {
        guard let port = daemonClient.httpPort else { return nil }
        return URL(string: "http://localhost:\(port)/pages/\(appId)")
    }

    func publishPage(html: String, title: String?, appId: String? = nil) {
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

    func bundleAndShare(appId: String) {
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

    private func toggleVoiceMode() {
        if voiceModeManager.state != .off {
            voiceModeManager.deactivate()
            windowState.selection = nil
        } else {
            // Ensure a thread exists
            if threadManager.activeViewModel == nil {
                threadManager.createThread()
            }
            windowState.selection = .panel(.voiceMode)
            // Activate directly — voiceInput was set on VoiceModeManager at MainWindow creation
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
                    threadManager.createThread()
                }
                preTemporaryChatThreadId = nil
            } else {
                preTemporaryChatThreadId = threadManager.activeThreadId
                threadManager.createPrivateThread()
            }
        }
    }

    private func requestHomeBaseDashboardIfNeeded() {
        guard !isBootstrapOnboardingActive else { return }
        // Auto-enable the dashboard once after bootstrap completes.
        // Uses a one-time sentinel so users can later disable it without
        // having it force-re-enabled on every launch.
        if !homeBaseDashboardAutoEnabled {
            homeBaseDashboardAutoEnabled = true
            homeBaseDashboardDefaultEnabled = true
        }
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

    /// Resolve display names for thread export.
    private func resolveParticipantNames() -> ChatTranscriptFormatter.ParticipantNames {
        // Assistant name: IdentityInfo → UserDefaults → fallback
        let assistantName = IdentityInfo.load()?.name
            ?? UserDefaults.standard.string(forKey: "assistantName")
            ?? "Assistant"

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

    // MARK: - Bootstrap Avatar Milestones

    /// Apply evolution milestones based on bootstrap conversation progress.
    /// Mirrors the pattern from FirstMeetingIntroductionView.applyConversationMilestones.
    private func applyBootstrapMilestones(turnCount: Int, messages: [ChatMessage], evoState: AvatarEvolutionState) {
        if turnCount >= 2 {
            DeterministicEvolutionEngine.applyMilestone(.nameChosen, to: evoState)
        }
        if turnCount >= 4 {
            let personalityText = messages
                .filter { $0.role == .assistant }
                .map(\.text)
                .joined(separator: " ")
            DeterministicEvolutionEngine.applyMilestone(
                .personalityDefined,
                to: evoState,
                context: MilestoneContext(personalityText: personalityText)
            )
        }
        if turnCount >= 6 {
            let emoji = IdentityInfo.load()?.emoji
            DeterministicEvolutionEngine.applyMilestone(
                .emojiChosen,
                to: evoState,
                context: MilestoneContext(emoji: emoji)
            )
        }
        if turnCount >= 8 {
            DeterministicEvolutionEngine.applyMilestone(.soulDiscussed, to: evoState)
        }
        if turnCount >= 10 {
            DeterministicEvolutionEngine.applyMilestone(.homeBaseCreated, to: evoState)
        }

        // Resolve updated traits into appearance
        let resolved = AvatarEvolutionResolver.resolve(state: evoState)
        AvatarAppearanceManager.shared.applyEvolutionResult(resolved)
        evoState.save()
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
            .onChange(of: windowState.selection) { oldSelection, newSelection in
                // Deactivate voice mode when navigating away from the voice panel
                if case .panel(.voiceMode) = oldSelection, voiceModeManager.state != .off {
                    if case .panel(.voiceMode) = newSelection {} else {
                        voiceModeManager.deactivate()
                    }
                }

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
            .onChange(of: threadManager.activeViewModel?.messages.map(\.id)) { _, _ in
                // Bootstrap avatar: apply milestones based on assistant turn count
                if let evoState = avatarEvolutionState, evoState.stage != .stabilized,
                   let viewModel = threadManager.activeViewModel {
                    let turnCount = viewModel.messages.filter { $0.role == .assistant }.count
                    if turnCount > lastAppliedBootstrapTurn {
                        applyBootstrapMilestones(turnCount: turnCount, messages: viewModel.messages, evoState: evoState)
                        lastAppliedBootstrapTurn = turnCount
                    }
                }
                requestHomeBaseDashboardIfNeeded()
            }
            // Poll for bootstrap completion so the dashboard is enabled even when
            // BOOTSTRAP.md is deleted via tool execution that only mutates
            // existing messages in place (no message-ID change to trigger
            // the .onChange above). Stops automatically once the auto-enable
            // flag is set.
            .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in
                guard !homeBaseDashboardAutoEnabled else { return }
                requestHomeBaseDashboardIfNeeded()
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
                    // Top bar (always visible, above sidebar)
                    HStack(spacing: 0) {
                        VIconButton(label: "Sidebar", icon: "sidebar.left", isActive: sidebarExpanded, iconOnly: true, tooltip: sidebarExpanded ? "Collapse sidebar" : "Expand sidebar") {
                            withAnimation(VAnimation.panel) {
                                sidebarExpanded.toggle()
                            }
                        }
                        Spacer()
                        if windowState.isShowingChat {
                            // Copy Thread button — only visible when there's content to copy
                            if threadManager.activeViewModel?.messages.contains(where: {
                                !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            }) == true {
                                Button {
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
                                    copyThreadConfirmationTimer?.cancel()
                                    showCopyThreadConfirmation = true
                                    let timer = DispatchWorkItem { showCopyThreadConfirmation = false }
                                    copyThreadConfirmationTimer = timer
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
                                } label: {
                                    Image(systemName: showCopyThreadConfirmation ? "checkmark" : "list.clipboard")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundColor(showCopyThreadConfirmation ? VColor.success : VColor.textMuted)
                                        .frame(width: 28, height: 28)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Copy thread")
                                .help(showCopyThreadConfirmation ? "Copied!" : "Copy thread")
                            }

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

                            TemporaryChatToggle(
                                isActive: threadManager.activeThread?.kind == .private,
                                tooltip: threadManager.activeThread?.kind == .private ? "Exit temporary chat" : "Temporary chat",
                                onToggle: { toggleTemporaryChat() }
                            )
                        }
                    }
                    .padding(.leading, trafficLightPadding)
                    .padding(.trailing, VSpacing.lg)
                    .frame(height: 36)

                    Divider().background(VColor.surfaceBorder)

                    // Content area: sidebar always pushes chat content right
                    HStack(spacing: 0) {
                        sidebarView
                            .animation(VAnimation.panel, value: sidebarExpanded)

                        chatContentView(geometry: geometry)
                    }
                }
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
                            onSettings: {
                                showControlCenterDrawer = false
                                windowState.selection = .panel(.settings)
                            },
                            onDebug: {
                                showControlCenterDrawer = false
                                windowState.selection = .panel(.debug)
                            },
                            onDoctor: {
                                showControlCenterDrawer = false
                                windowState.selection = .panel(.doctor)
                            }
                        )
                        .frame(width: sidebarExpandedWidth - VSpacing.sm * 2)
                        .offset(x: sidebarOuterMargin + VSpacing.sm, y: -52)
                        .zIndex(10)
                        .transition(.opacity)
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
            daemonClient.startSSE()
        }
        .onDisappear {
            daemonClient.stopSSE()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
        }
        .onReceive(daemonClient.$isConnected) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
            requestHomeBaseDashboardIfNeeded()
        }
        .onChange(of: sidebarExpanded) { _, isExpanded in
            if !isExpanded && showControlCenterDrawer {
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
            if case .panel(.identity) = windowState.selection {
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
                windowState.activeDynamicSurface = msg
                windowState.activeDynamicParsedSurface = Surface.from(msg)
                // Determine the app ID from the surface if available
                if let surface = windowState.activeDynamicParsedSurface,
                   case .dynamicPage(let dpData) = surface.data,
                   let appId = dpData.appId {
                    // Auto-dock chat alongside the app so the user can
                    // keep chatting while viewing the surface.
                    let threadId = threadManager.activeThreadId ?? threadManager.visibleThreads.first?.id
                    if let threadId {
                        threadManager.selectThread(id: threadId)
                        windowState.setAppEditing(appId: appId, threadId: threadId)
                    } else {
                        windowState.selection = .app(appId)
                    }
                } else {
                    windowState.selection = .app(msg.surfaceId)
                }
            }
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
            // Top-level nav panels deselect all threads
            if case .panel(let panel) = windowState.selection,
               panel == .directory || panel == .identity {
                return false
            }
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
            .padding(.leading, VSpacing.md)
            .padding(.trailing, isHovered ? (VSpacing.xs + 20 + VSpacing.xs + 20 + VSpacing.xs) : VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .background {
                if isSelected {
                    adaptiveColor(light: Color(hex: 0xE8E6DA), dark: Moss._700)
                } else if isHovered {
                    adaptiveColor(light: Stone._200, dark: Moss._700)
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
                    .padding(.trailing, VSpacing.xs + 20 + VSpacing.xs)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .contextMenu {
            Button {
                if thread.isPinned {
                    threadManager.unpinThread(id: thread.id)
                } else {
                    threadManager.pinThread(id: thread.id)
                }
            } label: {
                Label(thread.isPinned ? "Unpin" : "Pin to Top", systemImage: thread.isPinned ? "pin.slash" : "pin")
            }
            Button {
                threadManager.archiveThread(id: thread.id)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
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
        let all = threadManager.visibleThreads
        return showAllThreads ? all : Array(all.prefix(5))
    }

    private var displayedApps: [AppListManager.AppItem] {
        let all = appListManager.displayApps
        return showAllApps ? all : Array(all.prefix(5))
    }

    private let sidebarOuterMargin: CGFloat = 16

    @ViewBuilder
    var sidebarView: some View {
        VStack(spacing: 0) {
            if sidebarExpanded {
                expandedSidebarContent
            } else {
                collapsedSidebarContent
            }
        }
        .padding(sidebarExpanded ? VSpacing.xs : VSpacing.xs)
        .background(adaptiveColor(light: Moss._50, dark: Moss._700))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .padding(sidebarOuterMargin)
        .frame(width: sidebarExpanded ? sidebarExpandedWidth + sidebarOuterMargin * 2 : sidebarCollapsedWidth + sidebarOuterMargin * 2)
    }

    @ViewBuilder
    private var expandedSidebarContent: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer().frame(height: VSpacing.sm)

                // MARK: Nav Items
                SidebarNavRow(icon: "square.grid.2x2", label: "Home Base", isActive: windowState.activePanel == .directory) {
                    windowState.togglePanel(.directory)
                }
                SidebarNavRow(icon: "person.crop.circle", label: "Identity", isActive: windowState.activePanel == .identity) {
                    windowState.togglePanel(.identity)
                }
                SidebarNavRow(icon: "sparkles", label: "Skills", isActive: windowState.activePanel == .agent) {
                    windowState.togglePanel(.agent)
                }

                // Divider between nav items and threads
                VColor.divider
                    .frame(height: 1)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)

                // MARK: Threads
                SidebarThreadsHeader(onNewThread: {
                    windowState.selection = nil
                    threadManager.createThread()
                })

                ForEach(displayedThreads) { thread in
                    threadItem(thread)
                        .padding(.bottom, VSpacing.xxs)
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
                            .foregroundColor(adaptiveColor(light: Forest._600, dark: Forest._400))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 20)
                            .padding(.vertical, VSpacing.xs)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .scrollClipDisabled()
        .clipped()

        Spacer(minLength: VSpacing.sm)

        // Control Center row
        ControlCenterRow(
            onToggle: {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                    showControlCenterDrawer.toggle()
                }
            }
        )
    }

    @ViewBuilder
    private var collapsedSidebarContent: some View {
        VStack(spacing: VSpacing.sm) {
            CollapsedNavIcon(icon: "square.grid.2x2", label: "Home Base", isActive: windowState.activePanel == .directory) {
                windowState.togglePanel(.directory)
            }
            CollapsedNavIcon(icon: "person.crop.circle", label: "Identity", isActive: windowState.activePanel == .identity) {
                windowState.togglePanel(.identity)
            }
            CollapsedNavIcon(icon: "sparkles", label: "Skills", isActive: windowState.activePanel == .agent) {
                windowState.togglePanel(.agent)
            }

            VColor.divider
                .frame(height: 1)
                .padding(.horizontal, VSpacing.xs)

            CollapsedNavIcon(icon: "square.and.pencil", label: "New Chat", isActive: false) {
                windowState.selection = nil
                threadManager.createThread()
            }

            Spacer()

            CollapsedNavIcon(icon: "gearshape", label: "Control Center", isActive: false) {
                withAnimation(VAnimation.panel) {
                    sidebarExpanded = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                        showControlCenterDrawer = true
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func sidebarAppItem(_ app: AppListManager.AppItem) -> some View {
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
            .background(isHoveredApp == app.id ? VColor.hoverOverlay.opacity(0.08) : Color.clear)
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

private struct SidebarNavRow: View {
    let icon: String
    let label: String
    var isActive: Bool = false
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(VColor.textPrimary)
                    .frame(width: 18)
                Text(label)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
            }
            .padding(.leading, VSpacing.md)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .background(isActive || isHovered ? VColor.hoverOverlay.opacity(0.08) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, VSpacing.sm)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

private struct CollapsedNavIcon: View {
    let icon: String
    let label: String
    var isActive: Bool = false
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(VColor.textPrimary)
                .frame(width: 32, height: 32)
                .background(isActive || isHovered ? VColor.hoverOverlay.opacity(0.08) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

private struct SidebarThreadsHeader: View {
    let onNewThread: () -> Void
    @State private var isHovered = false

    var body: some View {
        HStack {
            Text("Threads")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)
            Spacer()
            Button(action: onNewThread) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(adaptiveColor(light: Forest._700, dark: Forest._400))
                    .frame(width: 22, height: 22)
                    .background(Color.clear)
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(adaptiveColor(light: Forest._700, dark: Forest._400), lineWidth: 1.5)
                    )
            }
            .buttonStyle(.plain)
            .scaleEffect(isHovered ? 1.08 : 1.0)
            .animation(VAnimation.fast, value: isHovered)
            .onHover { hovering in
                isHovered = hovering
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            .accessibilityLabel("New thread")
        }
        .padding(.leading, 20)
        .padding(.trailing, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
    }
}

private struct ControlCenterRow: View {
    let onToggle: () -> Void

    var body: some View {
        VButton(
            label: "Control Center",
            leftIcon: "gearshape",
            rightIcon: "chevron.up",
            style: .secondary,
            size: .medium,
            isFullWidth: true,
            action: onToggle
        )
        .padding(.horizontal, VSpacing.sm)
        .padding(.bottom, VSpacing.sm)
    }
}

private struct DrawerMenuView: View {
    let onSettings: () -> Void
    let onDebug: () -> Void
    let onDoctor: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
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
        .shadow(color: .black.opacity(0.15), radius: 6, y: -2)
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
