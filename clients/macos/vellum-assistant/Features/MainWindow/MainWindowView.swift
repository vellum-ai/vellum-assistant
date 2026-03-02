import Combine
import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

// MARK: - Grouped State

/// Sharing/publishing state -- isolates workspace share and publish mutations
/// so they don't invalidate unrelated parts of MainWindowView.
@Observable
@MainActor
final class SharingState {
    var showSharePicker = false
    var isBundling = false
    var shareFileURL: URL?
    var isPublishing = false
    var publishedUrl: String?
    var publishError: String?
    var workspaceEditorContentHeight: CGFloat = 20
    /// Saved publish params for auto-retry after credential setup completes.
    var pendingPublish: (html: String, title: String?, appId: String?)?
    /// Timer for polling credential availability during setup flow.
    var credentialPollTimer: Timer?
    /// Stashed handler so onDisappear can restore it when polling is active.
    var previousVercelHandler: ((VercelApiConfigResponseMessage) -> Void)?
}

/// Sidebar interaction state -- hover, rename, expand/collapse lists, drawer.
@Observable
@MainActor
final class SidebarInteractionState {
    var isHoveredThread: UUID?
    var isHoveredApp: String?
    var threadPendingDeletion: UUID?
    var renamingThreadId: UUID?
    var renameText: String = ""
    var showAllThreads: Bool = false
    var showAllScheduleThreads: Bool = false
    var showAllApps: Bool = false
    var showPreferencesDrawer: Bool = false
    /// Thread ID that is currently the drop target during a drag-and-drop reorder.
    var dropTargetThreadId: UUID?
    /// Thread ID currently being dragged (set on drag start, cleared on drop).
    var draggingThreadId: UUID?
    /// Whether the drop indicator should appear at the bottom of the target (true)
    /// or the top (false). Set based on drag direction.
    var dropIndicatorAtBottom: Bool = false
}

/// Copy-thread confirmation state.
@Observable
@MainActor
final class CopyThreadState {
    var showConfirmation = false
    var confirmationTimer: DispatchWorkItem?

    func cancel() {
        confirmationTimer?.cancel()
        confirmationTimer = nil
        showConfirmation = false
    }
}

struct MainWindowView: View {
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var appListManager: AppListManager
    var zoomManager: ZoomManager
    var conversationZoomManager: ConversationZoomManager
    /// Plain `let` instead of `@ObservedObject` so SwiftUI doesn't observe
    /// TraceStore mutations when the DebugPanel isn't visible. DebugPanel
    /// itself uses `@ObservedObject` and is only instantiated when shown.
    let traceStore: TraceStore
    @ObservedObject var windowState: MainWindowState
    @State private var selectedThreadId: UUID?
    @State var sharing = SharingState()
    @State private var sidebar = SidebarInteractionState()
    @State private var copyThread = CopyThreadState()
    @AppStorage("isAppChatOpen") var isAppChatOpen: Bool = false
    @State private var jitPermissionManager = JITPermissionManager()
    /// Stores the thread ID the user was on before entering temporary chat,
    /// so we can restore it when they exit instead of jumping to visibleThreads.first
    /// (which may be a pinned thread unrelated to what they were doing).
    @State private var preTemporaryChatThreadId: UUID?

    @AppStorage("sidebarExpanded") var sidebarExpanded: Bool = true
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var systemIsDark: Bool = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    private let sidebarExpandedWidth: CGFloat = 240
    private let sidebarCollapsedWidth: CGFloat = 52
    @AppStorage("sidePanelWidth") var sidePanelWidth: Double = 400
    @AppStorage("appPanelWidth") var appPanelWidth: Double = -1
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

    @State private var showThreadSwitcher = false
    /// Work item for the delayed hover trigger on the collapsed thread section.
    @State private var threadSwitcherHoverTimer: DispatchWorkItem?
    /// Work item that dismisses the thread switcher popover after leaving the hover area.
    @State private var threadSwitcherDismissTimer: DispatchWorkItem?
    /// Whether the "coming alive" overlay is currently showing.
    @State private var showComingAlive: Bool

    init(threadManager: ThreadManager, appListManager: AppListManager, zoomManager: ZoomManager, conversationZoomManager: ConversationZoomManager, traceStore: TraceStore, daemonClient: DaemonClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, settingsStore: SettingsStore, authManager: AuthManager, windowState: MainWindowState, documentManager: DocumentManager, onMicrophoneToggle: @escaping () -> Void = {}, voiceModeManager: VoiceModeManager = VoiceModeManager(), onSendWakeUp: (() -> Void)? = nil) {
        self.threadManager = threadManager
        self.appListManager = appListManager
        self.zoomManager = zoomManager
        self.conversationZoomManager = conversationZoomManager
        self.traceStore = traceStore
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
        let gatewayBaseUrl = settingsStore.localGatewayTarget
        return URL(string: "\(gatewayBaseUrl)/pages/\(appId)")
    }

    func publishPage(html: String, title: String?, appId: String? = nil) {
        guard !sharing.isPublishing else { return }
        sharing.isPublishing = true
        sharing.publishError = nil

        Task { @MainActor in
            daemonClient.onPublishPageResponse = { [self] response in
                sharing.isPublishing = false
                if response.success, let url = response.publicUrl {
                    sharing.publishedUrl = url
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                } else if response.errorCode == "credentials_missing" {
                    // Save pending publish for auto-retry after credential setup
                    sharing.pendingPublish = (html: html, title: title, appId: appId)
                    // Open the chat dock so the user can see the credential setup flow.
                    // Use the publish target's appId (not windowState.selection) to avoid
                    // a race where the user navigates away before this async callback fires.
                    if let targetAppId = appId {
                        isAppChatOpen = true
                        let threadId = threadManager.activeThreadId ?? threadManager.visibleThreads.first?.id
                        if let threadId {
                            threadManager.selectThread(id: threadId)
                            windowState.setAppEditing(appId: targetAppId, threadId: threadId)
                        } else {
                            threadManager.createThread()
                            if let newThreadId = threadManager.activeThreadId {
                                windowState.setAppEditing(appId: targetAppId, threadId: newThreadId)
                            }
                        }
                    } else if case .app(let currentAppId) = windowState.selection {
                        isAppChatOpen = true
                        let threadId = threadManager.activeThreadId ?? threadManager.visibleThreads.first?.id
                        if let threadId {
                            threadManager.selectThread(id: threadId)
                            windowState.setAppEditing(appId: currentAppId, threadId: threadId)
                        } else {
                            threadManager.createThread()
                            if let newThreadId = threadManager.activeThreadId {
                                windowState.setAppEditing(appId: currentAppId, threadId: newThreadId)
                            }
                        }
                    }
                    // Inject message into active session to trigger assistant-driven setup
                    if let viewModel = threadManager.activeViewModel {
                        viewModel.inputText = "I need to set up a Vercel API token to publish my app. Please load the vercel-token-setup skill and follow its instructions."
                        viewModel.sendMessage()
                    }
                    startCredentialPollForPublish()
                } else if let error = response.error, error != "Cancelled" {
                    sharing.publishError = error
                    // Auto-dismiss error after 5 seconds
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                        if sharing.publishError == error {
                            withAnimation(VAnimation.standard) { sharing.publishError = nil }
                        }
                    }
                }
            }

            do {
                try daemonClient.sendPublishPage(html: html, title: title, appId: appId)
            } catch {
                sharing.isPublishing = false
            }
        }
    }

    /// Polls the daemon for Vercel credential availability every 3 seconds.
    /// When the credential appears, auto-retries the pending publish.
    /// Times out after 5 minutes.
    private func startCredentialPollForPublish() {
        sharing.credentialPollTimer?.invalidate()
        let startTime = Date()
        let timeout: TimeInterval = 300 // 5 minutes

        // Preserve SettingsStore's handler so it continues receiving updates
        // after polling ends. Without this, the poll closure permanently
        // overwrites SettingsStore's onVercelApiConfigResponse and hasVercelKey
        // is never updated again.
        sharing.previousVercelHandler = daemonClient.onVercelApiConfigResponse
        let previousHandler = sharing.previousVercelHandler

        sharing.credentialPollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [self] timer in
            Task { @MainActor in
                // Timeout check
                if Date().timeIntervalSince(startTime) > timeout {
                    timer.invalidate()
                    sharing.credentialPollTimer = nil
                    sharing.pendingPublish = nil
                    daemonClient.onVercelApiConfigResponse = previousHandler
                    sharing.previousVercelHandler = nil
                    return
                }

                // Poll for credential
                daemonClient.onVercelApiConfigResponse = { [self] response in
                    // Forward to the previous handler (e.g. SettingsStore) so it
                    // stays in sync with credential state during polling.
                    previousHandler?(response)

                    if response.success && response.hasToken, let pending = sharing.pendingPublish {
                        timer.invalidate()
                        sharing.credentialPollTimer = nil
                        sharing.pendingPublish = nil
                        daemonClient.onVercelApiConfigResponse = previousHandler
                        sharing.previousVercelHandler = nil
                        // Auto-retry publish with saved params
                        publishPage(html: pending.html, title: pending.title, appId: pending.appId)
                    }
                }
                do {
                    try daemonClient.sendVercelApiConfig(action: "get")
                } catch {
                    // Polling failure is non-fatal; will retry on next tick
                }
            }
        }
    }

    func bundleAndShare(appId: String) {
        guard !sharing.isBundling else { return }
        sharing.isBundling = true

        Task { @MainActor in
            daemonClient.onBundleAppResponse = { response in
                sharing.shareFileURL = URL(fileURLWithPath: response.bundlePath)
                sharing.isBundling = false
                sharing.showSharePicker = true
            }

            do {
                try daemonClient.sendBundleApp(appId: appId)
            } catch {
                sharing.isBundling = false
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
                threadManager.enterDraftMode()
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

    /// Whether the chat bubble toggle is active (chat is open).
    private var isChatBubbleActive: Bool {
        switch windowState.selection {
        case .appEditing:
            return true
        case .panel(let panelType) where panelType != .voiceMode && panelType != .documentEditor:
            return isAppChatOpen
        default:
            return false
        }
    }


    /// Resolve display names for thread export.
    private func resolveParticipantNames() -> ChatTranscriptFormatter.ParticipantNames {
        // Assistant name: IdentityInfo → UserDefaults → fallback
        let assistantName = IdentityInfo.load()?.name ?? "Assistant"

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

    /// Top bar extracted to break up type-checker complexity.
    private var topBarView: some View {
        HStack(spacing: VSpacing.sm) {
            VIconButton(label: "Sidebar", icon: "sidebar.left", isActive: sidebarExpanded, iconOnly: true, tooltip: sidebarExpanded ? "Collapse sidebar" : "Expand sidebar") {
                withAnimation(VAnimation.panel) {
                    sidebarExpanded.toggle()
                }
            }
            Spacer()
            PTTKeyIndicator {
                settingsStore.pendingSettingsTab = .voice
                windowState.selection = .panel(.settings)
            }
            if windowState.isShowingChat || isChatBubbleActive {
                // Copy Thread button — only visible when there's content to copy
                if threadManager.activeViewModel?.messages.contains(where: {
                    !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }) == true {
                    VIconButton(
                        label: "Copy thread",
                        icon: copyThread.showConfirmation ? "checkmark" : "list.clipboard",
                        isActive: copyThread.showConfirmation,
                        iconOnly: true,
                        tooltip: copyThread.showConfirmation ? "Copied!" : "Copy thread"
                    ) {
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
                        copyThread.cancel()
                        copyThread.showConfirmation = true
                        let timer = DispatchWorkItem { [copyThread] in copyThread.showConfirmation = false }
                        copyThread.confirmationTimer = timer
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
                    }
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
                        sidebarView

                        chatContentView(geometry: geometry)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                    }
                    .padding(16)
                    .animation(VAnimation.panel, value: sidebarExpanded)
                }
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
                .overlay(alignment: .bottomLeading) {
                    // Preferences drawer rendered at top level so it floats above all content
                    if sidebar.showPreferencesDrawer {
                        let drawerWidth = sidebarExpandedWidth - VSpacing.sm * 2
                        let drawerX = sidebarExpanded
                            ? 16 + VSpacing.sm
                            : 16 + sidebarCollapsedWidth - VSpacing.xs
                        DrawerMenuView(
                            onSettings: {
                                sidebar.showPreferencesDrawer = false
                                windowState.selection = .panel(.settings)
                            },
                            onDebug: {
                                sidebar.showPreferencesDrawer = false
                                windowState.selection = .panel(.debug)
                            }
                        )
                        .frame(width: drawerWidth)
                        .offset(x: drawerX, y: -28)
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
            copyThread.cancel()
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
        .onReceive(daemonClient.$isConnected) { _ in
            windowState.refreshAPIKeyStatus(isConnected: daemonClient.isConnected)
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
        .onChange(of: sidebar.isHoveredThread) { _, newValue in
            // Cancel pending archive when hover leaves the row or moves to a different thread.
            if let pending = sidebar.threadPendingDeletion, newValue != pending {
                sidebar.threadPendingDeletion = nil
            }
        }
    }

    @ViewBuilder
    private func threadItem(_ thread: ThreadModel) -> some View {
        let isSelected: Bool = {
            switch windowState.selection {
            case .panel:
                return false
            case .thread(let id):
                return id == thread.id
            case .appEditing(_, let threadId):
                return threadId == thread.id
            case .app, .none:
                // No explicit thread in selection; fall back to the persistent thread.
                return thread.id == windowState.persistentThreadId
            }
        }()
        let isHovered = sidebar.isHoveredThread == thread.id
        let interactionState = threadManager.interactionState(for: thread.id)
        // Reserve trailing space when hovered for archive button overlay.
        let hasTrailingIcon = isHovered || sidebar.threadPendingDeletion == thread.id
        // Always reserve 20pt leading slot so text never shifts.
        // Use a tap gesture instead of Button so .draggable() can coexist —
        // Button captures mouse-down and prevents drag initiation on macOS.
        Group {
            HStack(spacing: VSpacing.xs) {
                // Leading 20×20 slot: single render path.
                // Hovered → interactive pin button; not hovered → status indicator.
                if isHovered {
                    Button {
                        withAnimation(VAnimation.standard) {
                            if thread.isPinned {
                                threadManager.unpinThread(id: thread.id)
                            } else {
                                threadManager.pinThread(id: thread.id)
                            }
                        }
                    } label: {
                        Image(systemName: thread.isPinned ? "pin.fill" : "pin")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(thread.isPinned ? VColor.textMuted : VColor.textSecondary)
                            .rotationEffect(.degrees(-45))
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity)
                    .accessibilityLabel(thread.isPinned ? "Unpin \(thread.title)" : "Pin \(thread.title)")
                } else {
                    switch interactionState {
                    case .processing:
                        VBusyIndicator()
                            .frame(width: 20, height: 20)
                    case .waitingForInput:
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.warning)
                            .frame(width: 20, height: 20)
                    case .error:
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.error)
                            .frame(width: 20, height: 20)
                            .transition(.opacity)
                    case .idle:
                        if thread.hasUnseenLatestAssistantMessage {
                            Circle()
                                .fill(Color(hex: 0xE86B40))
                                .frame(width: 6, height: 6)
                                .frame(width: 20, height: 20)
                                .transition(.opacity)
                        } else if thread.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(VColor.textMuted)
                                .rotationEffect(.degrees(-45))
                                .frame(width: 20, height: 20)
                                .transition(.opacity)
                        } else {
                            Color.clear
                                .frame(width: 20, height: 20)
                        }
                    }
                }
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
                    .help(thread.title)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, hasTrailingIcon ? (VSpacing.xs + 20 + VSpacing.xs) : VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .background {
                if isSelected {
                    adaptiveColor(light: Moss._100, dark: Moss._700)
                } else if isHovered {
                    adaptiveColor(light: Moss._100, dark: Moss._700).opacity(0.5)
                } else if thread.kind == .private {
                    VColor.accent.opacity(0.04)
                } else {
                    Color.clear
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
            .animation(VAnimation.fast, value: isHovered)
        }
        .onTapGesture {
            selectThread(thread)
        }
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Thread: \(thread.title)")
        .accessibilityAction(.default) {
            selectThread(thread)
        }
        .overlay(alignment: .trailing) {
            if sidebar.threadPendingDeletion == thread.id {
                VButton(label: "Confirm", style: .danger, size: .small) {
                    threadManager.archiveThread(id: thread.id)
                    sidebar.threadPendingDeletion = nil
                }
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Confirm archive \(thread.title)")
            } else if isHovered {
                Button {
                    sidebar.threadPendingDeletion = thread.id
                } label: {
                    Image(systemName: "archivebox")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Archive \(thread.title)")
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .contextMenu {
            Button {
                withAnimation(VAnimation.standard) {
                    if thread.isPinned {
                        threadManager.unpinThread(id: thread.id)
                    } else {
                        threadManager.pinThread(id: thread.id)
                    }
                }
            } label: {
                Label(thread.isPinned ? "Unpin" : "Pin to Top", systemImage: thread.isPinned ? "pin.slash" : "pin")
            }
            if thread.sessionId != nil {
                Button {
                    sidebar.renamingThreadId = thread.id
                    sidebar.renameText = thread.title
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
            }
            Button {
                threadManager.archiveThread(id: thread.id)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                if hovering {
                    sidebar.isHoveredThread = thread.id
                } else {
                    if sidebar.isHoveredThread == thread.id {
                        sidebar.isHoveredThread = nil
                    }
                }
            }
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
        .onDrag {
            sidebar.draggingThreadId = thread.id
            return NSItemProvider(object: thread.id.uuidString as NSString)
        } preview: {
            HStack(spacing: VSpacing.xs) {
                if thread.isPinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 20, height: 20)
                } else {
                    Color.clear.frame(width: 20, height: 20)
                }
                Text(thread.title)
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
            }
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .frame(width: 220, alignment: .leading)
            .background(VColor.surface.opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }

    private func selectThread(_ thread: ThreadModel) {
        if case .appEditing(let appId, _) = windowState.selection {
            windowState.selection = .appEditing(appId: appId, threadId: thread.id)
            threadManager.selectThread(id: thread.id)
        } else {
            windowState.selection = .thread(thread.id)
            threadManager.selectThread(id: thread.id)
        }
    }

    /// Maps a thread's interaction state to a dot color for VThreadIcon.
    private func interactionDotColor(for thread: ThreadModel) -> Color? {
        switch threadManager.interactionState(for: thread.id) {
        case .processing: return VColor.accent
        case .waitingForInput: return VColor.warning
        case .error: return VColor.error
        case .idle: return nil
        }
    }

    private var regularThreads: [ThreadModel] {
        threadManager.visibleThreads.filter { !$0.isScheduleThread }
    }

    private var scheduleThreads: [ThreadModel] {
        threadManager.visibleThreads.filter { $0.isScheduleThread }
    }

    private var displayedThreads: [ThreadModel] {
        let all = regularThreads
        return sidebar.showAllThreads ? all : Array(all.prefix(5))
    }

    private var displayedScheduleThreads: [ThreadModel] {
        let all = scheduleThreads
        return sidebar.showAllScheduleThreads ? all : Array(all.prefix(3))
    }

    private var displayedApps: [AppListManager.AppItem] {
        let all = appListManager.displayApps
        return sidebar.showAllApps ? all : Array(all.prefix(5))
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
        .padding(VSpacing.xs)
        .frame(width: sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth, alignment: .leading)
        .background(adaptiveColor(light: Moss._50, dark: Moss._950))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .clipped()
        .alert("Rename Thread", isPresented: Binding(
            get: { sidebar.renamingThreadId != nil },
            set: { if !$0 { sidebar.renamingThreadId = nil } }
        )) {
            TextField("Title", text: Binding(
                get: { sidebar.renameText },
                set: { sidebar.renameText = $0 }
            ))
            Button("Cancel", role: .cancel) { sidebar.renamingThreadId = nil }
            Button("Save") {
                if let id = sidebar.renamingThreadId, !sidebar.renameText.isEmpty {
                    threadManager.updateThreadTitle(id: id, title: sidebar.renameText)
                    if let sessionId = threadManager.threads.first(where: { $0.id == id })?.sessionId {
                        try? daemonClient.send(IPCSessionRenameRequest(
                            type: "session_rename",
                            sessionId: sessionId,
                            title: sidebar.renameText
                        ))
                    }
                }
                sidebar.renamingThreadId = nil
            }
        } message: {
            Text("Enter a new name for this thread")
        }
    }

    // MARK: - Pinned App Helpers

    /// A pinned app row — delegates layout to `SidebarPrimaryRow` for both
    /// expanded and collapsed modes, then adds app-specific context menu and drag.
    @ViewBuilder
    private func sidebarPinnedAppRow(_ app: AppListManager.AppItem, isExpanded: Bool = true) -> some View {
        SidebarPrimaryRow(
            icon: app.sfSymbol ?? "square.grid.2x2",
            label: app.name,
            isActive: isAppSurfaceActive(appId: app.id),
            isExpanded: isExpanded
        ) {
            openAppInWorkspace(app: app)
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

    @ViewBuilder
    private var expandedSidebarContent: some View {
        VStack(spacing: VSpacing.sm) {
            Spacer().frame(height: 0)

            // MARK: Pinned Apps (above nav items)
            if !appListManager.pinnedApps.isEmpty {
                VStack(spacing: VSpacing.sm) {
                    ForEach(appListManager.pinnedApps) { app in
                        sidebarPinnedAppRow(app)
                    }
                }

                VColor.divider
                    .frame(height: 1)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
            }

            // MARK: Nav Items (fixed)
            SidebarNavRow(icon: "brain.head.profile", label: "Intelligence", isActive: windowState.activePanel == .intelligence) {
                windowState.togglePanel(.intelligence)
            }
            SidebarNavRow(icon: "square.grid.2x2", label: "Things", isActive: windowState.activePanel == .apps) {
                windowState.showAppsPanel()
            }

            // Divider between nav items and threads
            VColor.divider
                .frame(height: 1)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)

            // MARK: Threads (scrollable)
            SidebarThreadsHeader(
                hasUnseenThreads: threadManager.unseenVisibleConversationCount > 0,
                onMarkAllSeen: {
                    let markedIds = threadManager.markAllThreadsSeen()
                    guard !markedIds.isEmpty else { return }
                    let count = markedIds.count
                    let toastId = windowState.showToast(
                        message: "Marked \(count) thread\(count == 1 ? "" : "s") as seen",
                        style: .success,
                        primaryAction: VToastAction(label: "Undo") {
                            threadManager.restoreUnseen(threadIds: markedIds)
                            windowState.dismissToast()
                        },
                        onDismiss: {
                            threadManager.commitPendingSeenSignals()
                        }
                    )
                    threadManager.schedulePendingSeenSignals {
                        windowState.dismissToast(id: toastId)
                    }
                },
                onNewThread: {
                    windowState.selection = nil
                    threadManager.enterDraftMode()
                }
            )

            ScrollView {
                VStack(spacing: 0) {
                    ForEach(displayedThreads) { thread in
                        threadItem(thread)
                            .padding(.bottom, VSpacing.xxs)
                            .overlay(alignment: sidebar.dropIndicatorAtBottom ? .bottom : .top) {
                                if sidebar.dropTargetThreadId == thread.id {
                                    Rectangle()
                                        .fill(adaptiveColor(light: Forest._500, dark: Forest._400))
                                        .frame(height: 2)
                                        .transition(.opacity)
                                }
                            }
                            .dropDestination(for: String.self) { items, _ in
                                sidebar.dropTargetThreadId = nil
                                sidebar.draggingThreadId = nil
                                guard let droppedId = items.first,
                                      let sourceUUID = UUID(uuidString: droppedId),
                                      sourceUUID != thread.id else { return false }
                                return threadManager.moveThread(sourceId: sourceUUID, targetId: thread.id)
                            } isTargeted: { isTargeted in
                                if isTargeted && thread.id != sidebar.draggingThreadId {
                                    sidebar.dropTargetThreadId = thread.id
                                    if let dragId = sidebar.draggingThreadId {
                                        let visible = threadManager.visibleThreads
                                        let sIdx = visible.firstIndex(where: { $0.id == dragId }) ?? 0
                                        let tIdx = visible.firstIndex(where: { $0.id == thread.id }) ?? 0
                                        sidebar.dropIndicatorAtBottom = sIdx < tIdx
                                    }
                                } else if !isTargeted && sidebar.dropTargetThreadId == thread.id {
                                    sidebar.dropTargetThreadId = nil
                                }
                            }
                    }

                    if regularThreads.count > 5 {
                        Button {
                            withAnimation(VAnimation.standard) { sidebar.showAllThreads.toggle() }
                        } label: {
                            Text(sidebar.showAllThreads ? "Show less" : "Show more")
                                .font(VFont.caption)
                                .foregroundColor(adaptiveColor(light: Forest._600, dark: Forest._400))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.leading, VSpacing.sm + VSpacing.xs + 20 + VSpacing.xs)
                                .padding(.top, VSpacing.sm)
                                .padding(.bottom, VSpacing.xs)
                        }
                        .buttonStyle(.plain)
                    }

                    if !scheduleThreads.isEmpty {
                        // Scheduled threads section
                        HStack {
                            Text("Scheduled")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                            Spacer()
                        }
                        .padding(.leading, 20)
                        .padding(.trailing, VSpacing.md)
                        .padding(.top, VSpacing.md)
                        .padding(.bottom, VSpacing.xs)

                        ForEach(displayedScheduleThreads) { thread in
                            threadItem(thread)
                                .padding(.bottom, VSpacing.xxs)
                                .overlay(alignment: sidebar.dropIndicatorAtBottom ? .bottom : .top) {
                                    if sidebar.dropTargetThreadId == thread.id {
                                        Rectangle()
                                            .fill(adaptiveColor(light: Forest._500, dark: Forest._400))
                                            .frame(height: 2)
                                            .transition(.opacity)
                                    }
                                }
                                .dropDestination(for: String.self) { items, _ in
                                    sidebar.dropTargetThreadId = nil
                                    sidebar.draggingThreadId = nil
                                    guard let droppedId = items.first,
                                          let sourceUUID = UUID(uuidString: droppedId),
                                          sourceUUID != thread.id else { return false }
                                    return threadManager.moveThread(sourceId: sourceUUID, targetId: thread.id)
                                } isTargeted: { isTargeted in
                                    if isTargeted && thread.id != sidebar.draggingThreadId {
                                        if let dragId = sidebar.draggingThreadId {
                                            let sourceIsSchedule = threadManager.visibleThreads.first(where: { $0.id == dragId })?.isScheduleThread ?? false
                                            if !sourceIsSchedule {
                                                // Cross-section drag (regular → scheduled): insertion goes
                                                // to the section boundary, so show indicator at top of
                                                // the first schedule thread to match actual insertion point.
                                                sidebar.dropTargetThreadId = displayedScheduleThreads.first?.id ?? thread.id
                                                sidebar.dropIndicatorAtBottom = false
                                            } else {
                                                sidebar.dropTargetThreadId = thread.id
                                                let visible = threadManager.visibleThreads
                                                let sIdx = visible.firstIndex(where: { $0.id == dragId }) ?? 0
                                                let tIdx = visible.firstIndex(where: { $0.id == thread.id }) ?? 0
                                                sidebar.dropIndicatorAtBottom = sIdx < tIdx
                                            }
                                        } else {
                                            sidebar.dropTargetThreadId = thread.id
                                        }
                                    } else if !isTargeted && (sidebar.dropTargetThreadId == thread.id || sidebar.dropTargetThreadId == displayedScheduleThreads.first?.id) {
                                        sidebar.dropTargetThreadId = nil
                                    }
                                }
                        }

                        if scheduleThreads.count > 3 {
                            Button {
                                withAnimation(VAnimation.standard) { sidebar.showAllScheduleThreads.toggle() }
                            } label: {
                                Text(sidebar.showAllScheduleThreads ? "Show less" : "Show more")
                                    .font(VFont.caption)
                                    .foregroundColor(adaptiveColor(light: Forest._600, dark: Forest._400))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.leading, VSpacing.sm + VSpacing.xs + 20 + VSpacing.xs)
                                    .padding(.top, VSpacing.sm)
                                    .padding(.bottom, VSpacing.xs)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .scrollIndicators(.never)

            Spacer(minLength: VSpacing.sm)

            // Preferences row (fixed)
            PreferencesRow(
                onToggle: {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                        sidebar.showPreferencesDrawer.toggle()
                    }
                }
            )
        }
    }

    @ViewBuilder
    private var collapsedSidebarContent: some View {
        VStack(spacing: VSpacing.sm) {
            Spacer().frame(height: 0)

            // MARK: Pinned Apps (collapsed)
            if !appListManager.pinnedApps.isEmpty {
                VStack(spacing: VSpacing.sm) {
                    ForEach(appListManager.pinnedApps) { app in
                        sidebarPinnedAppRow(app, isExpanded: false)
                    }
                }

                VColor.divider
                    .frame(height: 1)
                    .padding(.horizontal, VSpacing.xs)
            }

            SidebarNavRow(icon: "brain.head.profile", label: "Intelligence", isActive: windowState.activePanel == .intelligence, isExpanded: false) {
                windowState.togglePanel(.intelligence)
            }
            SidebarNavRow(icon: "square.grid.2x2", label: "Things", isActive: windowState.activePanel == .apps, isExpanded: false) {
                windowState.showAppsPanel()
            }

            VColor.divider
                .frame(height: 1)
                .padding(.horizontal, VSpacing.xs)

            SidebarNavRow(icon: "square.and.pencil", label: "New Chat", isActive: false, isExpanded: false) {
                windowState.selection = nil
                threadManager.enterDraftMode()
            }

            // MARK: Thread Section (collapsed)
            if let activeThread = threadManager.activeThread {
                ZStack(alignment: .bottomTrailing) {
                    // Active thread icon
                    VThreadIcon(
                        title: activeThread.title,
                        size: .medium,
                        isActive: true,
                        dotColor: interactionDotColor(for: activeThread)
                    )

                    // Unseen dot overlay (bottom-right) — shows when any thread has unseen messages
                    if regularThreads.contains(where: { $0.hasUnseenLatestAssistantMessage }) {
                        Circle()
                            .fill(Color(hex: 0xE86B40))
                            .frame(width: 8, height: 8)
                            .offset(x: 4, y: 4)
                    }
                }
                .onDisappear {
                    threadSwitcherHoverTimer?.cancel()
                    threadSwitcherHoverTimer = nil
                    threadSwitcherDismissTimer?.cancel()
                    threadSwitcherDismissTimer = nil
                    showThreadSwitcher = false
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard regularThreads.count > 1 else { return }
                    threadSwitcherHoverTimer?.cancel()
                    threadSwitcherHoverTimer = nil
                    showThreadSwitcher.toggle()
                }
                .onHover { hovering in
                    guard regularThreads.count > 1 else { return }
                    if hovering {
                        // Cancel any pending dismiss
                        threadSwitcherDismissTimer?.cancel()
                        threadSwitcherDismissTimer = nil
                        // Start open timer
                        threadSwitcherHoverTimer?.cancel()
                        let work = DispatchWorkItem {
                            showThreadSwitcher = true
                        }
                        threadSwitcherHoverTimer = work
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
                    } else {
                        threadSwitcherHoverTimer?.cancel()
                        threadSwitcherHoverTimer = nil
                        // Schedule dismiss — gives time to move mouse into the popover
                        if showThreadSwitcher {
                            let dismiss = DispatchWorkItem {
                                showThreadSwitcher = false
                            }
                            threadSwitcherDismissTimer = dismiss
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: dismiss)
                        }
                    }
                }
                .popover(isPresented: $showThreadSwitcher, arrowEdge: .trailing) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        // Header
                        Text("\(regularThreads.count) THREADS")
                            .font(VFont.caption)
                            .fontWeight(.medium)
                            .foregroundColor(VColor.textMuted)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.top, VSpacing.sm)

                        // Thread list
                        ScrollView {
                            VStack(spacing: 0) {
                                ForEach(regularThreads) { thread in
                                    let isActive = thread.id == threadManager.activeThreadId
                                    HStack(spacing: VSpacing.xs) {
                                        VThreadIcon(
                                            title: thread.title,
                                            size: .small,
                                            isActive: isActive,
                                            dotColor: interactionDotColor(for: thread)
                                        )

                                        Text(thread.title)
                                            .font(VFont.body)
                                            .foregroundColor(VColor.textPrimary)
                                            .lineLimit(1)
                                            .truncationMode(.tail)

                                        Spacer()

                                        // Unseen indicator
                                        if thread.hasUnseenLatestAssistantMessage {
                                            Circle()
                                                .fill(Color(hex: 0xE86B40))
                                                .frame(width: 6, height: 6)
                                        }
                                    }
                                    .padding(.horizontal, VSpacing.sm)
                                    .padding(.vertical, VSpacing.xs)
                                    .background(isActive ? VColor.accent.opacity(0.12) : Color.clear)
                                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                    .contentShape(Rectangle())
                                    .onTapGesture {
                                        selectThread(thread)
                                        showThreadSwitcher = false
                                    }
                                }
                            }
                            .padding(.horizontal, VSpacing.xs)
                        }
                        .frame(maxHeight: 300)
                    }
                    .frame(width: 200)
                    .padding(.bottom, VSpacing.sm)
                    .onHover { hovering in
                        if hovering {
                            // Mouse entered popover — cancel pending dismiss
                            threadSwitcherDismissTimer?.cancel()
                            threadSwitcherDismissTimer = nil
                        } else {
                            // Mouse left popover — dismiss after short delay
                            let dismiss = DispatchWorkItem {
                                showThreadSwitcher = false
                            }
                            threadSwitcherDismissTimer = dismiss
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: dismiss)
                        }
                    }
                }
            }

            Spacer()

            SidebarNavRow(icon: "slider.horizontal.3", label: "Preferences", isActive: false, isExpanded: false) {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                    sidebar.showPreferencesDrawer.toggle()
                }
            }

            Spacer().frame(height: 0)
        }
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
        // Reset sticky chat dock so apps open in view-only mode by default
        isAppChatOpen = false
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

struct ZoomIndicatorView: View {
    let percentage: Int
    /// Optional prefix shown before the percentage (e.g. "Text" → "Text 125%").
    var label: String? = nil

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            if let label {
                Text(label)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textSecondary)
            }
            Text("\(percentage)%")
                .font(VFont.bodyMedium)
                .foregroundStyle(VColor.textPrimary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityLabel("Zoom \(percentage) percent")
    }
}

/// Unified sidebar row used by both nav items and pinned apps.
/// Handles expanded (icon + label) and collapsed (icon-only) modes
/// with consistent spacing, backgrounds, and hover behavior.
private struct SidebarPrimaryRow: View {
    let icon: String
    let label: String
    var isActive: Bool = false
    var isExpanded: Bool = true
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: isExpanded ? VSpacing.xs : 0) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(adaptiveColor(light: Color(hex: 0x4B6845), dark: Forest._400))
                    .frame(width: 20)
                Text(label)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(width: isExpanded ? nil : 0, alignment: .leading)
                    .clipped()
                    .opacity(isExpanded ? 1 : 0)
                    .allowsHitTesting(false)
                if isExpanded {
                    Spacer()
                }
            }
            .padding(.leading, isExpanded ? VSpacing.xs : 0)
            .padding(.trailing, isExpanded ? VSpacing.sm : 0)
            .padding(.vertical, VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: isExpanded ? .leading : .center)
            .background(isActive ? adaptiveColor(light: Moss._100, dark: Moss._700) : isHovered ? adaptiveColor(light: Moss._100, dark: Moss._700).opacity(0.5) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
            .animation(VAnimation.fast, value: isHovered)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, isExpanded ? VSpacing.sm : VSpacing.xs)
        .help(isExpanded ? "" : label)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

/// Convenience alias — existing callsites use `SidebarNavRow`.
private typealias SidebarNavRow = SidebarPrimaryRow

private struct SidebarThreadsHeader: View {
    let hasUnseenThreads: Bool
    let onMarkAllSeen: () -> Void
    let onNewThread: () -> Void

    var body: some View {
        HStack {
            Text("Threads")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(VColor.textPrimary)
            Spacer()
            if hasUnseenThreads {
                VIconButton(
                    label: "Mark all as seen",
                    icon: "checkmark.circle",
                    iconOnly: true,
                    tooltip: "Mark all as seen",
                    action: onMarkAllSeen
                )
            }
            VIconButton(label: "New thread", icon: "plus", iconOnly: true, action: onNewThread)
        }
        .padding(.leading, 20)
        .padding(.trailing, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .contextMenu {
            Button {
                onMarkAllSeen()
            } label: {
                Label("Mark All as Seen", systemImage: "checkmark.circle")
            }
            .disabled(!hasUnseenThreads)
        }
    }
}

private struct PreferencesRow: View {
    let onToggle: () -> Void

    var body: some View {
        VButton(
            label: "Preferences",
            leftIcon: "slider.horizontal.3",
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
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DrawerThemeToggle()
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            DrawerMenuItem(icon: "gearshape", label: "Settings", action: onSettings)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            DrawerMenuItem(icon: "ladybug", label: "Debug", action: onDebug)
        }
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 6, y: -2)
    }
}

/// Compact three-way theme toggle (System / Light / Dark) for the control center drawer.
private struct DrawerThemeToggle: View {
    @AppStorage("themePreference") private var themePreference: String = "system"

    private struct ThemeOption {
        let value: String
        let icon: String
        let tooltip: String
    }

    private let options: [ThemeOption] = [
        ThemeOption(value: "system", icon: "circle.lefthalf.filled", tooltip: "System"),
        ThemeOption(value: "light", icon: "sun.max.fill", tooltip: "Light"),
        ThemeOption(value: "dark", icon: "moon.fill", tooltip: "Dark"),
    ]

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Theme")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
            Spacer()
            HStack(spacing: 2) {
                ForEach(options, id: \.value) { option in
                    let isSelected = themePreference == option.value
                    Button {
                        themePreference = option.value
                        AppDelegate.shared?.applyThemePreference()
                    } label: {
                        Image(systemName: option.icon)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(isSelected ? VColor.textPrimary : VColor.textMuted)
                            .frame(width: 28, height: 22)
                            .background(
                                isSelected
                                    ? VColor.hoverOverlay.opacity(0.1)
                                    : Color.clear
                            )
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    }
                    .buttonStyle(.plain)
                    .help(option.tooltip)
                    .accessibilityLabel("\(option.tooltip) theme")
                    .accessibilityValue(isSelected ? "Selected" : "")
                }
            }
            .padding(2)
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
        }
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
