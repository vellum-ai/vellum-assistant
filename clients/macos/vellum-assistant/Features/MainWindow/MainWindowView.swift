import Combine
import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct MainWindowView: View {
    @ObservedObject var conversationManager: ConversationManager
    @ObservedObject var appListManager: AppListManager
    var zoomManager: ZoomManager
    var conversationZoomManager: ConversationZoomManager
    /// Plain `let` instead of `@ObservedObject` so SwiftUI doesn't observe
    /// TraceStore mutations when the DebugPanel isn't visible. DebugPanel
    /// itself uses `@ObservedObject` and is only instantiated when shown.
    let traceStore: TraceStore
    let usageDashboardStore: UsageDashboardStore
    @ObservedObject var windowState: MainWindowState
    @StateObject var assistantFeatureFlagStore: AssistantFeatureFlagStore
    @State private var selectedConversationId: UUID?
    @State var sharing = SharingState()
    @State var sidebar = SidebarInteractionState()
    @AppStorage("isAppChatOpen") var isAppChatOpen: Bool = false
    @State private var jitPermissionManager = JITPermissionManager()
    @State var showConversationActionsDrawer = false
    /// Frame of the conversation title button in the coordinate space of coreLayoutView,
    /// used to position the actions drawer directly below it.
    @State private var conversationTitleFrame: CGRect = .zero
    /// Stores the conversation ID the user was on before entering temporary chat,
    /// so we can restore it when they exit instead of jumping to visibleConversations.first
    /// (which may be a pinned conversation unrelated to what they were doing).
    @State private var preTemporaryChatConversationId: UUID?

    @AppStorage("sidebarExpanded") var sidebarExpanded: Bool = true
    /// True when the sidebar was auto-collapsed by entering an app panel.
    /// Used to distinguish automatic collapse from manual user collapse so
    /// we only re-expand the sidebar on app exit when it was our doing.
    @State private var sidebarAutoCollapsedForApp = false
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
    @ObservedObject var updateManager: UpdateManager

    /// Callback to send the wake-up greeting after the "coming alive" transition.
    /// Nil for returning users (no transition).
    let onSendWakeUp: (() -> Void)?

    @State var showConversationSwitcher = false
    @State var conversationSwitcherTriggerFrame: CGRect = .zero
    /// Whether the "coming alive" overlay is currently showing.
    @State private var showComingAlive: Bool
    /// Whether the daemon-loading skeleton overlay is currently showing.
    @State var showDaemonLoading: Bool
    /// Mirrors `AppDelegate.daemonStartupError` so SwiftUI re-renders the
    /// daemon loading overlay when a structured error arrives or is cleared.
    @State private var daemonStartupError: DaemonStartupError?

    init(conversationManager: ConversationManager, appListManager: AppListManager, zoomManager: ZoomManager, conversationZoomManager: ConversationZoomManager, traceStore: TraceStore, usageDashboardStore: UsageDashboardStore, daemonClient: DaemonClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, settingsStore: SettingsStore, authManager: AuthManager, windowState: MainWindowState, documentManager: DocumentManager, onMicrophoneToggle: @escaping () -> Void = {}, voiceModeManager: VoiceModeManager, updateManager: UpdateManager, onSendWakeUp: (() -> Void)? = nil) {
        self.conversationManager = conversationManager
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
        self._assistantFeatureFlagStore = StateObject(
            wrappedValue: AssistantFeatureFlagStore()
        )
        self.documentManager = documentManager
        self.onMicrophoneToggle = onMicrophoneToggle
        self.voiceModeManager = voiceModeManager
        self.updateManager = updateManager
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

    func toggleVoiceMode() {
        if voiceModeManager.state != .off {
            voiceModeManager.deactivate()
        } else {
            // Ensure a conversation exists
            if conversationManager.activeViewModel == nil {
                conversationManager.enterDraftMode()
            }
            // Activate directly — voice bar appears automatically via ComposerSection
            if let viewModel = conversationManager.activeViewModel {
                voiceModeManager.activate(chatViewModel: viewModel, settingsStore: settingsStore)
                voiceModeManager.startListening()
            }
        }
    }

    private func toggleTemporaryChat() {
        withAnimation(VAnimation.standard) {
            if let privateConversation = conversationManager.activeConversation, privateConversation.kind == .private {
                let privateId = privateConversation.id

                // Restore the conversation the user was on before entering temporary chat.
                // Fall back to visibleConversations.first only if the stored conversation no longer exists.
                if let savedId = preTemporaryChatConversationId,
                   conversationManager.visibleConversations.contains(where: { $0.id == savedId }) {
                    conversationManager.selectConversation(id: savedId)
                } else if let recent = conversationManager.visibleConversations.first {
                    conversationManager.selectConversation(id: recent.id)
                } else {
                    conversationManager.enterDraftMode()
                }
                preTemporaryChatConversationId = nil

                // Delete the private conversation and its backend conversation.
                conversationManager.removePrivateConversation(id: privateId)
            } else {
                preTemporaryChatConversationId = conversationManager.activeConversationId
                conversationManager.createPrivateConversation()
            }
        }
    }

    /// Resolve a conversation ID for the chat bubble toggle using strict priority:
    /// 1. activeConversationId (currently selected conversation)
    /// 2. persistentConversationId (app's last-used conversation)
    /// 3. visibleConversations.first (first available conversation)
    /// 4. create a new conversation
    private func resolveConversationId() -> UUID {
        if let id = conversationManager.activeConversationId { return id }
        if let id = windowState.persistentConversationId { return id }
        if let id = conversationManager.visibleConversations.first?.id { return id }
        conversationManager.createConversation()
        return conversationManager.activeConversationId!
    }

    func enterAppEditing(appId: String) {
        let conversationId = resolveConversationId()
        conversationManager.selectConversation(id: conversationId)
        windowState.setAppEditing(appId: appId, conversationId: conversationId)
    }

    func exitAppEditing(appId: String) {
        windowState.selection = .app(appId)
    }

    /// Resolve display names for conversation export.
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

    func copyActiveConversationToClipboard() {
        let messages = conversationManager.activeViewModel?.messages ?? []
        let title = conversationManager.activeConversation?.title
        let names = resolveParticipantNames()
        let markdown = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: title,
            participantNames: names
        )
        guard !markdown.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown, forType: .string)
        windowState.showToast(message: "Conversation copied to clipboard", style: .success)
    }

    private var conversationHeaderPresentation: ConversationHeaderPresentation {
        ConversationHeaderPresentation(
            activeConversation: conversationManager.activeConversation,
            activeViewModel: conversationManager.activeViewModel,
            isConversationVisible: windowState.isConversationVisible
        )
    }

    func dismissConversationDrawer() {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
            showConversationActionsDrawer = false
        }
    }

    func startRenameActiveConversation() {
        guard let id = conversationManager.activeConversationId,
              let conversation = conversationManager.activeConversation else { return }
        sidebar.renamingConversationId = id
        sidebar.renameText = conversation.title
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
            .onChange(of: conversationManager.activeConversationId) { oldId, newId in
                // Deactivate voice mode on a real conversation switch (UUID → different UUID),
                // but not on draft promotion (nil → UUID) which happens on first send.
                if let oldId, oldId != newId, voiceModeManager.state != .off {
                    voiceModeManager.deactivate()
                }
                // Dismiss conversation actions drawer on conversation switch
                if showConversationActionsDrawer {
                    showConversationActionsDrawer = false
                }
            }
            .onChange(of: windowState.selection) { oldSelection, newSelection in
                // When selection transitions to .conversation, ensure ConversationManager is synced
                // so chat content targets the correct conversation (e.g. after dismissOverlay).
                // Guard against archived conversations: if the conversation was archived while an
                // overlay was open, persistentConversationId may still point to the stale ID.
                if case .conversation(let id) = newSelection {
                    if conversationManager.conversations.contains(where: { $0.id == id && !$0.isArchived }) {
                        conversationManager.selectConversation(id: id)
                    } else {
                        // Conversation was archived/deleted — fall back to the first visible conversation
                        if let fallback = conversationManager.visibleConversations.first {
                            windowState.applySelectionCorrection(.conversation(fallback.id))
                        } else {
                            windowState.applySelectionCorrection(nil)
                        }
                    }
                }

                // Sync surface and chat dock state when selection changes
                let expanded = windowState.isDynamicExpanded
                let docked = windowState.isChatDockOpen
                conversationManager.activeViewModel?.activeSurfaceId = expanded ? windowState.activeDynamicSurface?.surfaceId : nil
                conversationManager.activeViewModel?.isChatDockedToSide = expanded && docked

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

                // Collapse the sidebar when an app opens to avoid crowding;
                // re-expand when leaving an app so other panels see the sidebar.
                let wasApp: Bool = {
                    switch oldSelection {
                    case .app, .appEditing: return true
                    default: return false
                    }
                }()
                let isApp: Bool = {
                    switch newSelection {
                    case .app, .appEditing: return true
                    default: return false
                    }
                }()
                if sidebarExpanded && isApp {
                    withAnimation(VAnimation.panel) {
                        sidebarExpanded = false
                        sidebarAutoCollapsedForApp = true
                    }
                } else if sidebarAutoCollapsedForApp && wasApp && !isApp {
                    withAnimation(VAnimation.panel) {
                        sidebarExpanded = true
                        sidebarAutoCollapsedForApp = false
                    }
                }
            }
            .onChange(of: windowState.activeDynamicSurface?.surfaceId) { _, surfaceId in
                if windowState.isDynamicExpanded {
                    conversationManager.activeViewModel?.activeSurfaceId = surfaceId
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

    /// Daemon loading overlay extracted to reduce type-checker pressure on `coreLayoutView`.
    @ViewBuilder
    private var daemonLoadingOverlayIfNeeded: some View {
        if showDaemonLoading && !isSettingsOpen {
            DaemonLoadingOverlayContent(
                error: daemonStartupError,
                onRetry: { handleDaemonRetry() },
                onSendLogs: { AppDelegate.shared?.showLogReportWindow(reason: .connectionIssue) }
            )
            .transition(.opacity)
        }
    }

    private func handleDaemonRetry() {
        daemonStartupError = nil
        AppDelegate.shared?.daemonStartupError = nil
        showDaemonLoading = true
        retryDaemonStartup()
    }

    /// Top bar extracted to break up type-checker complexity.
    private var topBarView: some View {
        HStack(spacing: VSpacing.sm) {
            if !isSettingsOpen {
                VButton(label: "Sidebar", iconOnly: VIcon.panelLeft.rawValue, style: .ghost, tooltip: sidebarExpanded ? "Collapse sidebar" : "Expand sidebar") {
                    withAnimation(VAnimation.panel) {
                        sidebarExpanded.toggle()
                    }
                }

                VButton(label: "Search", iconOnly: VIcon.search.rawValue, style: .ghost, tooltip: "Search (\u{2318}K)") {
                    AppDelegate.shared?.toggleCommandPalette()
                }

                HStack(spacing: 0) {
                    VButton(label: "Back", iconOnly: VIcon.chevronLeft.rawValue, style: .ghost, tooltip: "Back (\u{2318}[)") {
                        windowState.navigateBack()
                    }
                    .disabled(!windowState.navigationHistory.canGoBack)
                    .opacity(windowState.navigationHistory.canGoBack ? 1 : 0.35)

                    VButton(label: "Forward", iconOnly: VIcon.chevronRight.rawValue, style: .ghost, tooltip: "Forward (\u{2318}])") {
                        windowState.navigateForward()
                    }
                    .disabled(!windowState.navigationHistory.canGoForward)
                    .opacity(windowState.navigationHistory.canGoForward ? 1 : 0.35)
                }
            }
            Spacer()
            if windowState.isConversationVisible {
                ConversationTitleActionsControl(
                    presentation: conversationHeaderPresentation,
                    onCopy: { copyActiveConversationToClipboard(); dismissConversationDrawer() },
                    onPin: {
                        guard let id = conversationManager.activeConversationId else { return }
                        conversationManager.pinConversation(id: id)
                        dismissConversationDrawer()
                    },
                    onUnpin: {
                        guard let id = conversationManager.activeConversationId else { return }
                        conversationManager.unpinConversation(id: id)
                        dismissConversationDrawer()
                    },
                    onArchive: {
                        guard let id = conversationManager.activeConversationId else { return }
                        conversationManager.archiveConversation(id: id)
                        dismissConversationDrawer()
                    },
                    onRename: { startRenameActiveConversation(); dismissConversationDrawer() },
                    showDrawer: $showConversationActionsDrawer
                )
                .background(GeometryReader { proxy in
                    Color.clear.onAppear {
                        conversationTitleFrame = proxy.frame(in: .named("coreLayout"))
                    }
                    .onChange(of: proxy.frame(in: .named("coreLayout"))) { _, newFrame in
                        conversationTitleFrame = newFrame
                    }
                })
            }
            Spacer()
            if updateManager.isUpdateAvailable {
                VButton(
                    label: updateManager.isDeferredUpdateReady ? "Restart to update" : "Update",
                    leftIcon: VIcon.arrowUp.rawValue,
                    style: .primary,
                    size: .pill,
                    tooltip: updateManager.isDeferredUpdateReady ? "Restart to install the latest version" : "A new version is available"
                ) {
                    if updateManager.isDeferredUpdateReady {
                        NSApp.terminate(nil)
                    } else {
                        updateManager.checkForUpdates()
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
                .animation(VAnimation.fast, value: updateManager.isUpdateAvailable)
            }
            PTTKeyIndicator {
                settingsStore.pendingSettingsTab = .voice
                windowState.selection = .panel(.settings)
            }
            if windowState.isConversationVisible {
                // Temporary chat toggle — always visible on private conversations (so users can exit temp chat),
                // only visible on normal conversations when no messages exist yet
                if conversationManager.activeConversation?.kind == .private || conversationManager.activeViewModel?.messages.contains(where: {
                    !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }) != true {
                    TemporaryChatToggle(
                        isActive: conversationManager.activeConversation?.kind == .private,
                        tooltip: conversationManager.activeConversation?.kind == .private ? "Exit temporary chat" : "Temporary chat",
                        onToggle: { toggleTemporaryChat() }
                    )
                }
            }
        }
        .padding(.leading, trafficLightPadding)
        .padding(.trailing, VSpacing.lg)
        .frame(height: 48)
        .background(VColor.surfaceOverlay)
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
                            .animation(VAnimation.panel, value: sidebarExpanded)
                            .overlay {
                                daemonLoadingOverlayIfNeeded
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
                                withAnimation(VAnimation.snappy) {
                                    sidebar.showPreferencesDrawer = false
                                }
                            }
                    }
                }
                .overlay {
                    // Click-outside-to-dismiss background for conversation actions drawer
                    if showConversationActionsDrawer {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { dismissConversationDrawer() }
                    }
                }
                .overlay(alignment: .topLeading) {
                    if showConversationActionsDrawer {
                        let presentation = conversationHeaderPresentation
                        ConversationActionsDrawer(
                            presentation: presentation,
                            onCopy: { copyActiveConversationToClipboard(); dismissConversationDrawer() },
                            onPin: {
                                guard let id = conversationManager.activeConversationId else { return }
                                conversationManager.pinConversation(id: id)
                                dismissConversationDrawer()
                            },
                            onUnpin: {
                                guard let id = conversationManager.activeConversationId else { return }
                                conversationManager.unpinConversation(id: id)
                                dismissConversationDrawer()
                            },
                            onArchive: {
                                guard let id = conversationManager.activeConversationId else { return }
                                conversationManager.archiveConversation(id: id)
                                dismissConversationDrawer()
                            },
                            onRename: { startRenameActiveConversation(); dismissConversationDrawer() }
                        )
                        .offset(x: conversationTitleFrame.minX, y: conversationTitleFrame.maxY)
                        .zIndex(10)
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    // Preferences drawer rendered at top level so it floats above all content
                    if sidebar.showPreferencesDrawer {
                        let drawerWidth = sidebarExpandedWidth - VSpacing.sm * 2
                        let bottomPad: CGFloat = 16 + (sidebarExpanded ? VSpacing.md : VSpacing.sm)
                        // Position above the PreferencesRow: clear the row height + divider + gap
                        let dividerHeight: CGFloat = 1 + SidebarLayoutMetrics.dividerVerticalPadding * 2
                        let drawerY = bottomPad + SidebarLayoutMetrics.rowMinHeight + dividerHeight + VSpacing.xs
                        DrawerMenuView(
                            authManager: authManager,
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
                            },
                            onSignIn: {
                                sidebar.showPreferencesDrawer = false
                                Task {
                                    await authManager.loginWithToast(showToast: { msg, style in
                                        windowState.showToast(message: msg, style: style)
                                    })
                                }
                            },
                            onOpenBilling: {
                                sidebar.showPreferencesDrawer = false
                                settingsStore.pendingSettingsTab = .billing
                                windowState.selection = .panel(.settings)
                            }
                        )
                        .frame(width: drawerWidth)
                        .offset(x: 16 + VSpacing.sm, y: -drawerY)
                        .zIndex(10)
                        .transition(.scale(scale: 0.96, anchor: .bottom).combined(with: .opacity))
                    }
                }
                .overlay {
                    if showConversationSwitcher {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture {
                                showConversationSwitcher = false
                            }
                    }
                }
                .overlay(alignment: .topLeading) {
                    if showConversationSwitcher {
                        ConversationSwitcherDrawer(
                            regularConversations: regularConversations,
                            activeConversationId: conversationManager.activeConversationId,
                            conversationManager: conversationManager,
                            windowState: windowState,
                            sidebar: sidebar,
                            selectConversation: { selectConversation($0) },
                            onDismiss: { showConversationSwitcher = false }
                        )
                        .frame(width: sidebarExpandedWidth - VSpacing.sm * 2)
                        .offset(
                            x: 16 + sidebarCollapsedWidth - VSpacing.xs,
                            y: conversationSwitcherTriggerFrame.minY
                        )
                        .zIndex(10)
                        .transition(.opacity)
                        .onChange(of: conversationManager.activeConversationId) { _, _ in
                            showConversationSwitcher = false
                        }
                        .onChange(of: sidebarExpanded) { _, expanded in
                            if expanded { showConversationSwitcher = false }
                        }
                    }
                }
            }
            .ignoresSafeArea(edges: .top)
            .background(VColor.surfaceBase.ignoresSafeArea())
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
                    .padding(.top, 40)
                    .shadow(color: VColor.auxBlack.opacity(0.15), radius: 8, y: 2)
            }
        }
        .animation(VAnimation.fast, value: zoomManager.showZoomIndicator)
        .overlay(alignment: .top) {
            Group {
                if let viewModel = conversationManager.activeViewModel {
                    ErrorToastOverlay(
                        errorManager: viewModel.errorManager,
                        hasAPIKey: windowState.hasAPIKey,
                        onOpenSettings: { windowState.selection = .panel(.settings) },
                        onRetryConversationError: { viewModel.retryAfterConversationError() },
                        onCopyDebugInfo: { viewModel.copyConversationErrorDebugDetails() },
                        onDismissConversationError: { viewModel.dismissConversationError() },
                        onSendAnyway: { viewModel.sendAnyway() },
                        onRetryLastMessage: { viewModel.retryLastMessage() },
                        onDismissError: { viewModel.dismissError() }
                    )
                } else if !windowState.hasAPIKey {
                    ChatConversationErrorToast(
                        message: "API key not set. Add one in Settings to start chatting.",
                        icon: .keyRound,
                        accentColor: VColor.systemMidStrong,
                        actionLabel: "Open Settings",
                        onAction: { windowState.selection = .panel(.settings) }
                    )
                    .fixedSize(horizontal: true, vertical: false)
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
                    .padding(.top, VSpacing.sm)
                    .animation(VAnimation.fast, value: windowState.hasAPIKey)
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .overlay(alignment: .bottom) {
            if let toast = windowState.toastInfo {
                VToast(
                    message: toast.message,
                    style: toast.style == .success ? .success : toast.style == .warning ? .warning : .error,
                    copyableDetail: toast.copyableDetail,
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
            // Reset stale chat-dock state for users upgrading from older versions.
            // Without this, isAppChatOpen could remain persisted as true with
            // no UI to disable it, leaving panels stuck in split mode.
            isAppChatOpen = false
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected, isAuthenticated: authManager.isAuthenticated)
            selectedConversationId = conversationManager.activeConversationId
            // Initialize persistent conversation tracking on launch
            if let activeId = conversationManager.activeConversationId {
                windowState.persistentConversationId = activeId
            }
            daemonClient.startSSE()
            // Sync initial daemon startup error state
            daemonStartupError = AppDelegate.shared?.daemonStartupError
        }
        .task {
            guard let appDelegate = AppDelegate.shared else { return }
            for await error in appDelegate.$daemonStartupError.values {
                daemonStartupError = error
            }
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
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected, isAuthenticated: authManager.isAuthenticated)
        }
        .onReceive(daemonClient.$isConnected) { connected in
            windowState.refreshAPIKeyStatus(isConnected: connected, isAuthenticated: authManager.isAuthenticated)

            // Fallback for fresh users with 0 conversations: dismiss skeleton after a
            // short delay once the daemon is connected. Only applies during initial load.
            guard connected, showDaemonLoading else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                guard showDaemonLoading else { return }
                withAnimation(VAnimation.standard) {
                    showDaemonLoading = false
                }
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected, isAuthenticated: isAuthenticated)
        }
        .onChange(of: conversationManager.conversations.isEmpty) { _, isEmpty in
            // Dismiss skeleton when conversations arrive from daemon
            if !isEmpty && showDaemonLoading {
                withAnimation(VAnimation.standard) {
                    showDaemonLoading = false
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            conversationManager.markActiveConversationSeenIfNeeded()
        }
        .onChange(of: selectedConversationId) { _, newId in
            if let newId = newId {
                conversationManager.selectConversation(id: newId)
            }
        }
        .onChange(of: conversationManager.activeConversationId) { oldId, newId in
            // Sync activeConversationId changes back to selectedConversationId to keep sidebar selection in sync
            selectedConversationId = newId
            // Always sync persistentConversationId so the sidebar highlights the
            // correct conversation — even when an overlay (.panel, .app) is active.
            // Without this, archiving the active conversation while viewing a panel
            // leaves persistentConversationId pointing at the archived (invisible) conversation
            // and the sidebar shows no active highlight.
            // Clear it when entering draft mode (nil) so no conversation appears active.
            windowState.persistentConversationId = newId
            if case .panel(.intelligence) = windowState.selection {
                windowState.selection = nil
            }
            // Clear subagent detail panel on conversation switch
            windowState.selectedSubagentId = nil
            // Clear stale activeSurfaceId on the old conversation and sync the new one
            if let oldId {
                conversationManager.clearActiveSurface(conversationId: oldId)
            }
            conversationManager.activeViewModel?.activeSurfaceId = windowState.isDynamicExpanded ? windowState.activeDynamicSurface?.surfaceId : nil
            conversationManager.activeViewModel?.isChatDockedToSide = windowState.isDynamicExpanded && windowState.isChatDockOpen
            // Consume any buffered deep-link message now that a conversation is active.
            // Mirrors the iOS pattern (ChatTabView.onAppear, ConversationListView.onAppear)
            // where consumeDeepLinkIfNeeded() is called when the view model becomes
            // visible. Without this, deep links arriving before the window/conversation is
            // fully initialized are silently dropped on macOS.
            conversationManager.activeViewModel?.consumeDeepLinkIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDynamicWorkspace)) { notification in
            if let msg = notification.userInfo?["surfaceMessage"] as? UiSurfaceShowMessage {
                // Full message from daemon live event (AppDelegate path)
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
                // send a fresh ui_surface_show via SSE with the full payload.
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
        .onReceive(NotificationCenter.default.publisher(for: .pinApp)) { notification in
            guard let appId = notification.userInfo?["appId"] as? String else { return }
            appListManager.pinApp(id: appId)
            NotificationCenter.default.post(
                name: Notification.Name("MainWindow.appPinStateChanged"),
                object: nil,
                userInfo: ["appId": appId, "isPinned": true]
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .unpinApp)) { notification in
            guard let appId = notification.userInfo?["appId"] as? String else { return }
            appListManager.unpinApp(id: appId)
            NotificationCenter.default.post(
                name: Notification.Name("MainWindow.appPinStateChanged"),
                object: nil,
                userInfo: ["appId": appId, "isPinned": false]
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .queryAppPinState)) { notification in
            guard let appId = notification.userInfo?["appId"] as? String else { return }
            let pinned = appListManager.apps.first(where: { $0.id == appId })?.isPinned ?? false
            NotificationCenter.default.post(
                name: Notification.Name("MainWindow.appPinStateChanged"),
                object: nil,
                userInfo: ["appId": appId, "isPinned": pinned]
            )
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
        // SidebarInteractionState.setConversationHover(conversationId:hovering:)
    }

    /// Restart the daemon process without re-hatching a new assistant.
    /// Stops the existing daemon, then re-hatches with daemonOnly + restart
    /// flags to avoid creating a duplicate assistant entry.
    private func retryDaemonStartup() {
        Task {
            let assistantName = UserDefaults.standard.string(forKey: "connectedAssistantId")
            guard let appDelegate = AppDelegate.shared else { return }
            appDelegate.assistantCli.stop(name: assistantName)
            do {
                try await appDelegate.assistantCli.hatch(
                    name: assistantName,
                    daemonOnly: true,
                    restart: true
                )
            } catch let error as AssistantCli.CLIError {
                if case .daemonStartupFailed(let startupError) = error {
                    appDelegate.daemonStartupError = startupError
                    daemonStartupError = startupError
                    MetricKitManager.reportDaemonStartupFailure(startupError)
                }
                return
            } catch {
                return
            }
            // Reconnect the daemon client after a successful restart
            if !appDelegate.daemonClient.isConnected && !appDelegate.daemonClient.isConnecting {
                try? await appDelegate.daemonClient.connect()
            }
        }
    }

}

// MARK: - Error Toast Overlay

/// Wrapper view that directly observes a `ChatViewModel` via `@ObservedObject`,
/// ensuring error state changes (conversationError, errorText) trigger UI updates
/// even though MainWindowView only observes ConversationManager.
///
/// By capturing the viewModel reference at render-time, closures always act on
/// the correct conversation's ViewModel — even if the user switches conversations while a
/// toast is visible.
private struct ErrorToastOverlay: View {
    @ObservedObject var errorManager: ChatErrorManager
    let hasAPIKey: Bool
    let onOpenSettings: () -> Void
    let onRetryConversationError: () -> Void
    let onCopyDebugInfo: () -> Void
    let onDismissConversationError: () -> Void
    let onSendAnyway: () -> Void
    let onRetryLastMessage: () -> Void
    let onDismissError: () -> Void

    var body: some View {
        VStack(alignment: .center, spacing: VSpacing.xs) {
            if !hasAPIKey {
                ChatConversationErrorToast(
                    message: "API key not set. Add one in Settings to start chatting.",
                    icon: .keyRound,
                    accentColor: VColor.systemMidStrong,
                    actionLabel: "Open Settings",
                    onAction: onOpenSettings
                )
                .fixedSize(horizontal: true, vertical: false)
                .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
            }

            if let conversationError = errorManager.conversationError, !conversationError.isCreditsExhausted, !errorManager.isConversationErrorDisplayedInline {
                ChatConversationErrorToast(
                    error: conversationError,
                    onRetry: onRetryConversationError,
                    onCopyDebugInfo: onCopyDebugInfo,
                    onDismiss: onDismissConversationError
                )
                .fixedSize(horizontal: true, vertical: false)
                .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
            }

            if let errorText = errorManager.errorText, errorManager.conversationError == nil {
                ChatConversationErrorToast(
                    message: errorText,
                    subtitle: errorManager.isConnectionError ? errorManager.connectionDiagnosticHint : nil,
                    actionLabel: errorManager.isSecretBlockError ? "Send Anyway" : (errorManager.isRetryableError || (errorManager.isConnectionError && errorManager.hasRetryPayload)) ? "Retry" : nil,
                    onAction: errorManager.isSecretBlockError ? onSendAnyway : (errorManager.isRetryableError || (errorManager.isConnectionError && errorManager.hasRetryPayload)) ? onRetryLastMessage : nil,
                    onDismiss: onDismissError
                )
                .fixedSize(horizontal: true, vertical: false)
                .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
            }
        }
        .padding(.top, VSpacing.sm)
        .animation(VAnimation.fast, value: hasAPIKey)
        .animation(VAnimation.fast, value: errorManager.conversationError != nil)
        .animation(VAnimation.fast, value: errorManager.errorText != nil)
    }
}

// MARK: - Daemon Loading Overlay Content

/// Standalone view for the daemon loading overlay that shows either a
/// structured error view or the default skeleton placeholder.
/// Extracted from MainWindowView to reduce type-checker complexity in
/// `coreLayoutView`.
private struct DaemonLoadingOverlayContent: View {
    let error: DaemonStartupError?
    let onRetry: () -> Void
    let onSendLogs: () -> Void

    var body: some View {
        if let error {
            ZStack {
                VColor.surfaceBase
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                DaemonStartupErrorView(
                    error: error,
                    onRetry: onRetry,
                    onSendLogs: onSendLogs
                )
            }
        } else {
            DaemonLoadingChatSkeleton()
        }
    }
}
