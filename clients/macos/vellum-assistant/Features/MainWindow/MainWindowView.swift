import os
import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MainWindowView")

/// Target for the "Archive All" confirmation alert.
struct ArchiveAllTarget {
    let displayName: String
    let ids: [UUID]
}

struct MainWindowView: View {
    @Bindable var conversationManager: ConversationManager
    /// `@Observable` source of truth for the conversation list (conversations,
    /// groups, cached sidebar partitions, visible / unseen counts). Views
    /// that render the sidebar read these properties straight from the store
    /// rather than through `ConversationManager` forwarders so Observation
    /// tracking is anchored on the object that owns the mutation, as
    /// recommended by [Managing model data in your app](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app).
    /// Taking the store as an explicit parameter (instead of reading
    /// `conversationManager.listStore` at each call site) documents the
    /// sidebar's read-only contract with the store at the view boundary.
    let listStore: ConversationListStore
    let appListManager: AppListManager
    let zoomManager: ZoomManager
    /// Plain `let` instead of `@ObservedObject` so SwiftUI doesn't observe
    /// TraceStore mutations when the LogsAndUsagePanel isn't visible.
    /// LogsTabContent itself uses `@ObservedObject` and is only instantiated when shown.
    let traceStore: TraceStore
    let usageDashboardStore: UsageDashboardStore
    /// The four managers below are `@Observable`, so plain stored properties
    /// are sufficient — SwiftUI's Observation machinery tracks only the
    /// specific properties read inside `body` (and inside the modifier chain)
    /// rather than invalidating the entire view on any change.
    ///
    /// `windowState` is `@Bindable` because `PanelCoordinator` needs
    /// `$windowState.pendingMemoryId` / `$windowState.pendingSkillId`
    /// binding projections to pass into the logs-and-usage panel. Unlike
    /// `@ObservedObject`, `@Bindable` doesn't establish its own view
    /// invalidation policy — Observation still tracks property granularly.
    @Bindable var windowState: MainWindowState
    var assistantFeatureFlagStore: AssistantFeatureFlagStore
    @State var selectedConversationId: UUID?
    @State var sharing = SharingState()
    @State var sidebar = SidebarInteractionState()
    @AppStorage("isAppChatOpen") var isAppChatOpen: Bool = false
    @State private var jitPermissionManager = JITPermissionManager()
    /// Window size tracked via onGeometryChange, used for zoom scaling
    /// and panel width calculations without a synchronous GeometryReader.
    @State private var windowSize: CGSize = CGSize(width: 800, height: 600)
    @AppStorage("sidebarExpanded") var sidebarExpanded: Bool = true
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State var systemIsDark: Bool = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark"
    let sidebarExpandedWidth: CGFloat = 240
    let sidebarCollapsedWidth: CGFloat = 52
    @AppStorage("sidePanelWidth") var sidePanelWidth: Double = 400
    @AppStorage("appPanelWidth") var appPanelWidth: Double = -1
    @AppStorage("appChatDockWidth") var appChatDockWidth: Double = -1
    let connectionManager: GatewayConnectionManager
    let eventStreamClient: EventStreamClient
    let surfaceManager: SurfaceManager
    let ambientAgent: AmbientAgent
    let settingsStore: SettingsStore
    let authManager: AuthManager
    let documentManager: DocumentManager
    /// Shared observable store for ACP (Agent Client Protocol) sessions.
    /// Owned by ``AppServices`` and threaded through here so the
    /// ``ACPSessionsPanel`` route in ``PanelCoordinator`` can drive its
    /// list off the same instance ``ConversationManager`` updates from SSE.
    let acpSessionStore: ACPSessionStore
    let onMicrophoneToggle: () -> Void
    var voiceModeManager: VoiceModeManager
    var updateManager: UpdateManager

    /// Callback to send the wake-up greeting after the "coming alive" transition.
    /// Nil for returning users (no transition).
    let onSendWakeUp: (() -> Void)?

    @State var showConversationSwitcher = false
    @State var showEarnCreditsModal = false
    @State var conversationSwitcherTriggerFrame: CGRect = .zero
    /// Selected conversation currently being activated from a user navigation
    /// action. While non-nil, the chat surface renders a switch-loading
    /// skeleton until this conversation becomes active and history is loaded.
    @State var pendingConversationSwitchId: UUID? = nil

    /// Cached assistant display name, seeded from the static identity cache on init
    /// and refreshed when the daemon emits an identity change event.
    @State var cachedAssistantName: String
    /// Whether cachedAssistantName has been resolved from IDENTITY.md at least once.
    @State var assistantNameResolved: Bool
    /// Whether the "coming alive" overlay is currently showing.
    @State private var showComingAlive: Bool
    /// Whether the daemon-loading skeleton overlay is currently showing.
    @State var showAssistantLoading: Bool
    /// Whether the assistant loading has timed out (assistant unreachable).
    @State var assistantLoadingTimedOut = false
    @State private var isPreparingVoiceMode = false
    /// Whether the main window is in native macOS fullscreen (traffic lights hidden).
    @State var isInFullscreen: Bool = false
    /// Long-lived store for the Home page. Constructed eagerly so the Home
    /// sidebar panel always has a backing store the instant the user toggles
    /// the `home-tab` flag on, even if the panel is opened without a
    /// relaunch. The cost (one SSE subscriber + one foreground observer +
    /// one cached HTTP client) is small enough that gating construction on
    /// the flag isn't worth the runtime-toggle surface bug it created.
    @State var homeStore: HomeStore
    @State var feedStore: HomeFeedStore
    /// Long-lived view model that tracks the live meeting status pushed by
    /// the daemon's `meet.*` SSE events. Rendered as the top-of-gallery
    /// status panel on the Home page. Constructed eagerly (same rationale
    /// as the Home stores) so the panel is wired up the moment the user
    /// lands on Home, without having to refresh.
    @State var meetStatusViewModel: MeetStatusViewModel
    /// When non-nil, the Home panel splits into a two-pane layout and
    /// renders the appropriate detail panel on the trailing edge for the
    /// tapped feed item. Driven by ``HomeDetailPanelKind.resolve(for:)``
    /// so all dispatch rules live in one place. Owned here (rather than
    /// inside ``HomePageView``) so the selection survives any @ViewBuilder
    /// rebuild of the Home panel wrapper.
    @State var activeHomeDetailPanel: HomeDetailPanelKind? = nil
    init(conversationManager: ConversationManager, appListManager: AppListManager, zoomManager: ZoomManager, traceStore: TraceStore, usageDashboardStore: UsageDashboardStore, connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient, surfaceManager: SurfaceManager, ambientAgent: AmbientAgent, settingsStore: SettingsStore, authManager: AuthManager, windowState: MainWindowState, assistantFeatureFlagStore: AssistantFeatureFlagStore, documentManager: DocumentManager, acpSessionStore: ACPSessionStore, onMicrophoneToggle: @escaping () -> Void = {}, voiceModeManager: VoiceModeManager, updateManager: UpdateManager, onSendWakeUp: (() -> Void)? = nil, initialAssistantName: String? = nil) {
        self.conversationManager = conversationManager
        self.listStore = conversationManager.listStore
        self.appListManager = appListManager
        self.zoomManager = zoomManager
        self.traceStore = traceStore
        self.usageDashboardStore = usageDashboardStore
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.surfaceManager = surfaceManager
        self.ambientAgent = ambientAgent
        self.settingsStore = settingsStore
        self.authManager = authManager
        self.windowState = windowState
        self.assistantFeatureFlagStore = assistantFeatureFlagStore
        self.documentManager = documentManager
        self.acpSessionStore = acpSessionStore
        self.onMicrophoneToggle = onMicrophoneToggle
        self.voiceModeManager = voiceModeManager
        self.updateManager = updateManager
        self.onSendWakeUp = onSendWakeUp
        let cached = IdentityInfo.loadFromDiskCache()
        self._cachedAssistantName = State(initialValue: AssistantDisplayName.resolve(cached?.name, initialAssistantName, fallback: "Your Assistant"))
        self._assistantNameResolved = State(initialValue: cached != nil || initialAssistantName != nil)
        self._showComingAlive = State(initialValue: onSendWakeUp != nil)
        // Show skeleton loading only for normal launches (not post-onboarding where
        // ComingAliveOverlay handles the transition).
        self._showAssistantLoading = State(initialValue: onSendWakeUp == nil)
        // Eagerly construct the Home store so it's ready the moment the user
        // toggles the `home-tab` flag on — even if the panel is opened
        // without an app relaunch.
        self._homeStore = State(initialValue: HomeStore(
            client: DefaultHomeStateClient(),
            messageStream: eventStreamClient.subscribe()
        ))
        // Same eager-construction rationale for the activity feed store
        // — ready the instant the `home-feed` flag flips on.
        self._feedStore = State(initialValue: HomeFeedStore(
            client: DefaultHomeFeedClient(),
            messageStream: eventStreamClient.subscribe()
        ))
        // Meet status panel subscribes to the same shared SSE stream.
        self._meetStatusViewModel = State(initialValue: MeetStatusViewModel(
            messageStream: eventStreamClient.subscribe()
        ))
    }

    var trafficLightPadding: CGFloat {
        isInFullscreen ? VSpacing.lg : 78
    }

    func toggleVoiceMode() {
        if voiceModeManager.state != .off {
            voiceModeManager.deactivate()
        } else {
            guard !isPreparingVoiceMode else { return }
            isPreparingVoiceMode = true
            Task { @MainActor in
                defer { isPreparingVoiceMode = false }

                guard let viewModel = await conversationManager.prepareActiveConversationForVoiceMode() else {
                    windowState.showToast(
                        message: "Couldn't start voice mode. Check that the assistant is connected.",
                        style: .error
                    )
                    return
                }

                guard voiceModeManager.state == .off else { return }
                voiceModeManager.activate(chatViewModel: viewModel, settingsStore: settingsStore)
                voiceModeManager.startListening()
            }
        }
    }

    /// Resolve an existing conversation ID for the chat-dock entry paths using strict priority:
    /// 1. activeConversationId (currently selected conversation)
    /// 2. persistentConversationId (app's last-used conversation)
    /// 3. visibleConversations.first (first available conversation)
    /// 4. createConversation() — which may enter draft mode without committing a UUID
    ///
    /// Returns `nil` when no committed conversation is available. `createConversation()`
    /// lands in draft mode (see `ConversationManager.enterDraftMode`), which deliberately
    /// keeps `activeConversationId == nil` until the user sends their first message and the
    /// draft is promoted. Callers must handle the nil case; force-unwrapping would crash
    /// whenever the user invokes this path with zero existing conversations (LUM-968).
    private func resolveConversationId() -> UUID? {
        if let id = conversationManager.activeConversationId { return id }
        if let id = windowState.persistentConversationId { return id }
        if let id = listStore.visibleConversations.first?.id { return id }
        conversationManager.createConversation()
        return conversationManager.activeConversationId
    }

    func enterAppEditing(appId: String) {
        // Draft mode: dock onto the draft directly using its pre-assigned local
        // UUID. Going through resolveConversationId here would route to a stale
        // committed conversation (visibleConversations.first), and calling
        // selectConversation with the draft id would fail because the draft
        // isn't in the conversation list until first-message promotion.
        if conversationManager.activeConversationId == nil,
           let draftLocalId = conversationManager.draftLocalId {
            windowState.setAppEditing(appId: appId, conversationId: draftLocalId)
            return
        }
        guard let conversationId = resolveConversationId() else {
            // No committed conversation available — createConversation() entered draft
            // mode, which has no UUID until first user send. Fall back to `.app(appId)`
            // (no chat dock) so the user still lands on the app they requested. The dock
            // becomes available once a conversation exists.
            log.info("enterAppEditing: no conversation available, opening app without chat dock (appId=\(appId, privacy: .public))")
            windowState.selection = .app(appId)
            return
        }
        conversationManager.selectConversation(id: conversationId)
        windowState.setAppEditing(appId: appId, conversationId: conversationId)
    }

    func exitAppEditing(appId: String) {
        windowState.selection = .app(appId)
    }

    /// Resolve display names for conversation export.
    private func resolveParticipantNames() -> ChatTranscriptFormatter.ParticipantNames {
        let assistantName = assistantNameResolved
            ? cachedAssistantName
            : AssistantDisplayName.placeholder

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

    var conversationHeaderPresentation: ConversationHeaderPresentation {
        ConversationHeaderPresentation(
            activeConversation: conversationManager.activeConversation,
            activeViewModel: conversationManager.activeViewModel,
            isConversationVisible: windowState.isConversationVisible
        )
    }

    func startRenameActiveConversation() {
        guard let id = conversationManager.activeConversationId,
              let conversation = conversationManager.activeConversation else { return }
        sidebar.renamingConversationId = id
        sidebar.renameText = conversation.title
    }

    func openForkParentConversation() {
        guard let parentConversationId = conversationHeaderPresentation.forkParentConversationId else { return }
        let sourceMessageId = conversationHeaderPresentation.forkParentMessageId
        Task {
            _ = await conversationManager.openForkParentConversation(
                conversationId: parentConversationId,
                sourceMessageId: sourceMessageId
            )
        }
    }

    var body: some View {
        coreLayoutView
            .environment(assistantFeatureFlagStore)
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
            }
            .onChange(of: conversationManager.activeViewModel?.isHistoryLoaded) { _, isLoaded in
                guard isLoaded == true,
                      let pendingId = pendingConversationSwitchId,
                      pendingId == conversationManager.activeConversationId else { return }
                pendingConversationSwitchId = nil
            }
            .onChange(of: windowState.selection) { oldSelection, newSelection in
                // Validate the new selection synchronously so that if the target
                // is stale (archived / abandoned draft) we can correct the
                // selection on the current frame before it commits as an
                // invalid state. The heavy `ConversationManager` sync is
                // deferred below so SwiftUI can paint the selection change
                // before we block on VM creation.
                var conversationIdToActivate: UUID?
                let selectionTargetConversationId: UUID? = {
                    switch newSelection {
                    case .conversation(let id):
                        return id
                    case .appEditing(_, let id):
                        return id
                    default:
                        return nil
                    }
                }()
                if case .conversation(let id) = newSelection {
                    if listStore.conversations.contains(where: { $0.id == id && !$0.isArchived }) {
                        if conversationManager.activeConversationId != id {
                            conversationIdToActivate = id
                        }
                    } else {
                        // Conversation was archived/deleted — fall back to the first visible conversation
                        if let fallback = listStore.visibleConversations.first {
                            windowState.applySelectionCorrection(.conversation(fallback.id))
                        } else {
                            windowState.applySelectionCorrection(nil)
                        }
                    }
                } else if case .appEditing(let appId, let id) = newSelection {
                    // Validate the app-editing target. Nav history can replay an
                    // `.appEditing` whose conversationId references an abandoned
                    // draft (after switching to another conversation cleared
                    // `draftLocalId`) or an archived conversation. Without this
                    // guard the dock keeps rendering the previous
                    // `activeConversationId` while the sidebar highlights
                    // nothing — a mixed state the user lands in on Back.
                    let isCommittedAndVisible = listStore.conversations.contains { $0.id == id && !$0.isArchived }
                    let isCurrentDraft = conversationManager.draftLocalId == id
                    if isCommittedAndVisible {
                        if conversationManager.activeConversationId != id {
                            conversationIdToActivate = id
                        }
                    } else if !isCurrentDraft {
                        // Stale target — drop the dock but keep the app visible.
                        windowState.applySelectionCorrection(.app(appId))
                    }
                }

                // The skeleton gate is only for explicit user-initiated switches.
                // If selection is stale, inactive, or already rendered, clear it.
                if let id = conversationIdToActivate {
                    pendingConversationSwitchId = id
                } else if selectionTargetConversationId == nil
                    || selectionTargetConversationId == conversationManager.activeConversationId
                    || selectionTargetConversationId == conversationManager.draftLocalId {
                    pendingConversationSwitchId = nil
                }

                // Yield to the run loop before the heavy `ConversationManager`
                // sync so SwiftUI commits the selection-driven UI change
                // (sidebar highlight, chat container swap) on the current
                // frame. A cache-miss through `selectConversation(id:)`
                // synchronously builds a new `ChatViewModel` and wires three
                // Combine observers — without the yield, the main thread
                // stays busy for that entire window and a click appears to
                // do nothing until the conversation has fully loaded.
                // Surface / dock sync lives in the same Task because it
                // reads `activeViewModel`, which only reflects the new
                // conversation after `selectConversation` has run.
                Task { @MainActor in
                    if let id = conversationIdToActivate {
                        conversationManager.selectConversation(id: id)
                    }
                    let expanded = windowState.isDynamicExpanded
                    let docked = windowState.isChatDockOpen
                    conversationManager.activeViewModel?.activeSurfaceId = expanded ? windowState.activeDynamicSurface?.surfaceId : nil
                    conversationManager.activeViewModel?.isChatDockedToSide = expanded && docked
                }

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
                    windowState.clearDynamicWorkspaceState()
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
            }
            .onChange(of: windowState.activeDynamicSurface?.surfaceId) { _, surfaceId in
                if windowState.isDynamicExpanded {
                    conversationManager.activeViewModel?.activeSurfaceId = surfaceId
                }
            }
            .preferredColorScheme(themePreference == "light" ? .light : themePreference == "dark" ? .dark : systemIsDark ? .dark : .light)
    }

    private var isSettingsOpen: Bool {
        if case .panel(.settings) = windowState.selection { return true }
        if case .panel(.logsAndUsage) = windowState.selection { return true }
        return false
    }

    /// Assistant loading overlay shown during daemon startup.
    @ViewBuilder
    private var assistantLoadingOverlayIfNeeded: some View {
        if showAssistantLoading && !isSettingsOpen {
            AssistantLoadingOverlayContent(
                timedOut: $assistantLoadingTimedOut,
                onRetry: { rewakeAssistant() },
                onOpenSettings: {
                    settingsStore.pendingSettingsTab = .general
                    windowState.selection = .panel(.settings)
                },
                onSendLogs: { AppDelegate.shared?.showLogReportWindow(reason: .bugReport) }
            )
            .transition(.identity)
        }
    }

    /// Core layout with lifecycle modifiers and a single `.task` that
    /// observes all NotificationCenter notifications concurrently.
    private var coreLayoutView: some View {
        applyConversationSelectionModifiers(
            to: applyLifecycleModifiers(
                to: coreLayoutDecoratedView
            )
        )
        .task { await observeNotifications() }
    }

    private var coreLayoutGeometryView: some View {
        coreLayoutContent(windowSize: windowSize)
    }

    private var coreLayoutDecoratedView: some View {
        coreLayoutGeometryView
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .frame(minWidth: 800, minHeight: 600)
            .onGeometryChange(for: CGSize.self) { proxy in
                proxy.size
            } action: { newSize in
                windowSize = newSize
            }
            .overlay(alignment: .top) {
                ObservationBoundaryView {
                    MainWindowZoomIndicator(
                        showZoomIndicator: zoomManager.showZoomIndicator,
                        zoomPercentage: zoomManager.zoomPercentage
                    )
                }
            }
            .animation(VAnimation.fast, value: zoomManager.showZoomIndicator)
            .overlay(alignment: .top) {
                ObservationBoundaryView {
                    MainWindowVersionMismatchBanner(
                        connectionManager: connectionManager,
                        updateManager: updateManager,
                        settingsStore: settingsStore,
                        windowState: windowState
                    )
                }
            }
            .overlay(alignment: .top) {
                ObservationBoundaryView {
                    MainWindowErrorOverlay(
                        activeViewModel: conversationManager.activeViewModel,
                        settingsStore: settingsStore,
                        windowState: windowState
                    )
                }
            }
            .overlay(alignment: .bottom) {
                ObservationBoundaryView {
                    MainWindowToastOverlay(windowState: windowState)
                        .animation(VAnimation.standard, value: windowState.toastInfo != nil)
                }
            }
            .overlay {
                ObservationBoundaryView {
                    JITPermissionView(manager: jitPermissionManager)
                }
            }
            .overlay {
                ObservationBoundaryView {
                    if windowState.imageLightbox != nil {
                        ImageLightboxOverlay(windowState: windowState)
                            .transition(.opacity)
                    }
                }
            }
            .animation(VAnimation.standard, value: windowState.imageLightbox != nil)
            .overlay {
                ObservationBoundaryView {
                    UpgradeProgressOverlay(connectionManager: connectionManager)
                }
            }
    }

    @ViewBuilder
    private func coreLayoutContent(windowSize: CGSize) -> some View {
        coreLayoutBase(windowSize: windowSize)
            // Keep the zoomed canvas pinned to the top-left so width changes
            // do not recenter the layout and clip the sidebar off-screen.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .overlay { preferencesDismissLayer }
            .overlay(alignment: .bottomLeading) { preferencesDrawerLayer }
            .sheet(isPresented: $showEarnCreditsModal) {
                EarnCreditsModal()
                    .preferredColorScheme(themePreference == "light" ? .light : themePreference == "dark" ? .dark : systemIsDark ? .dark : .light)
            }
            .overlay { conversationSwitcherDismissLayer }
            .overlay(alignment: .topLeading) { conversationSwitcherDrawerLayer }
            .ignoresSafeArea(edges: .top)
            .background(VColor.surfaceBase.ignoresSafeArea())
            .frame(width: windowSize.width / zoomManager.zoomLevel,
                   height: windowSize.height / zoomManager.zoomLevel,
                   alignment: .topLeading)
            .scaleEffect(zoomManager.zoomLevel, anchor: .topLeading)
            .frame(width: windowSize.width, height: windowSize.height, alignment: .topLeading)
    }

    @ViewBuilder
    private func coreLayoutBase(windowSize: CGSize) -> some View {
        VStack(spacing: 0) {
            TopBarView(
                windowState: windowState,
                conversationManager: conversationManager,
                homeStore: homeStore,
                updateManager: updateManager,
                connectionManager: connectionManager,
                eventStreamClient: eventStreamClient,
                settingsStore: settingsStore,
                isInFullscreen: isInFullscreen,
                sidebarExpandedWidth: sidebarExpandedWidth,
                sidebarCollapsedWidth: sidebarCollapsedWidth,
                onCopyConversation: { copyActiveConversationToClipboard() },
                onRenameConversation: { startRenameActiveConversation() },
                onOpenForkParent: { openForkParentConversation() }
            )

            // Main container: sidebar + content with uniform padding
            HStack(spacing: 0) {
                sidebarView
                    .frame(width: isSettingsOpen ? 0 : (sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth))
                    .clipped()
                    .opacity(isSettingsOpen ? 0 : 1)
                    .allowsHitTesting(!isSettingsOpen)
                    .padding(.trailing, isSettingsOpen ? 0 : 16)
                    .animation(VAnimation.panel, value: sidebarExpanded)
                    .animation(VAnimation.panel, value: isSettingsOpen)

                ObservationBoundaryView {
                    chatContentView(windowSize: windowSize)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                        .clipped()
                }
                .animation(VAnimation.panel, value: sidebarExpanded)
                .animation(VAnimation.panel, value: isSettingsOpen)
                .overlay {
                    assistantLoadingOverlayIfNeeded
                }
            }
            .padding(16)
        }
        .coordinateSpace(name: "coreLayout")
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
struct ErrorToastOverlay: View {
    let errorManager: ChatErrorManager
    let onOpenModelsAndServices: () -> Void
    let onRetryConversationError: () -> Void
    let onCopyDebugInfo: () -> Void
    let onDismissConversationError: () -> Void
    let onSendAnyway: () -> Void
    let onRetryLastMessage: () -> Void
    let onDismissError: () -> Void

    var body: some View {
        VStack(alignment: .center, spacing: VSpacing.xs) {
            if let conversationError = errorManager.conversationError, !conversationError.isCreditsExhausted, !conversationError.isProviderNotConfigured, !errorManager.isConversationErrorDisplayedInline {
                ChatConversationErrorToast(
                    error: conversationError,
                    onRetry: onRetryConversationError,
                    onCopyDebugInfo: onCopyDebugInfo,
                    onDismiss: onDismissConversationError
                )
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
                .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
            }
        }
        .padding(.top, VSpacing.sm)
        .animation(VAnimation.fast, value: errorManager.conversationError != nil)
        .animation(VAnimation.fast, value: errorManager.errorText != nil)
    }
}

// MARK: - Assistant Loading Overlay Content

/// Assistant loading overlay that shows either a platform URL mismatch
/// error, a connection timeout error, or the default skeleton placeholder.
private struct AssistantLoadingOverlayContent: View {
    @Binding var timedOut: Bool
    let onRetry: () -> Void
    let onOpenSettings: () -> Void
    let onSendLogs: () -> Void

    /// How long to wait before showing the timeout error state.
    private static let timeoutSeconds: UInt64 = 15

    @State private var mismatch: PlatformURLMismatchInfo?

    var body: some View {
        if let mismatch {
            ZStack {
                VColor.surfaceBase
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                PlatformURLMismatchView(
                    configuredURL: mismatch.configuredURL,
                    lockfileURL: mismatch.lockfileURL,
                    onOpenSettings: onOpenSettings,
                    onSendLogs: onSendLogs
                )
            }
        } else if timedOut {
            ZStack {
                VColor.surfaceBase
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                AssistantConnectionTimeoutView(
                    onRetry: {
                        timedOut = false
                        onRetry()
                    },
                    onSendLogs: onSendLogs
                )
            }
        } else {
            DaemonLoadingChatSkeleton()
                .task {
                    mismatch = Self.detectPlatformURLMismatch()
                    guard mismatch == nil else { return }
                    try? await Task.sleep(nanoseconds: Self.timeoutSeconds * 1_000_000_000)
                    guard !Task.isCancelled else { return }
                    withAnimation(VAnimation.standard) {
                        timedOut = true
                    }
                }
        }
    }

    /// Checks whether the connected managed assistant's lockfile runtime URL
    /// matches the app's platform URL. Returns mismatch details when they
    /// differ, or nil when there is no mismatch (or the assistant is not managed).
    @MainActor
    private static func detectPlatformURLMismatch() -> PlatformURLMismatchInfo? {
        #if os(macOS)
        guard let assistantId = LockfileAssistant.loadActiveAssistantId(),
              let assistant = LockfileAssistant.loadByName(assistantId),
              assistant.isManaged,
              let lockfileURL = assistant.runtimeUrl,
              !lockfileURL.isEmpty else {
            return nil
        }

        let configuredURL = VellumEnvironment.resolvedPlatformURL
        let normalizedConfigured = normalizeURL(configuredURL)
        let normalizedLockfile = normalizeURL(lockfileURL)

        guard normalizedConfigured != normalizedLockfile else { return nil }
        return PlatformURLMismatchInfo(configuredURL: configuredURL, lockfileURL: lockfileURL)
        #else
        return nil
        #endif
    }

    private static func normalizeURL(_ url: String) -> String {
        url.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            .lowercased()
    }
}

/// Details of a platform URL mismatch between the app configuration and
/// the lockfile assistant entry.
private struct PlatformURLMismatchInfo {
    let configuredURL: String
    let lockfileURL: String
}

// MARK: - Conversation Title Overlay

/// Conversation title and actions overlay displayed in the top bar when
/// a conversation is active.
struct ConversationTitleOverlay: View {
    let conversationManager: ConversationManager
    let windowState: MainWindowState
    let sidebarExpanded: Bool
    let sidebarExpandedWidth: CGFloat
    let sidebarCollapsedWidth: CGFloat
    let isSettingsOpen: Bool
    let onCopy: () -> Void
    let onForkConversation: () -> Void
    let onPin: () -> Void
    let onUnpin: () -> Void
    let onArchive: () -> Void
    let onRename: () -> Void
    let onOpenForkParent: () -> Void
    var onAnalyzeConversation: (() -> Void)? = nil
    let onRefresh: () -> Void
    var onOpenInNewWindow: (() -> Void)? = nil

    private var presentation: ConversationHeaderPresentation {
        ConversationHeaderPresentation(
            activeConversation: conversationManager.activeConversation,
            activeViewModel: conversationManager.activeViewModel,
            isConversationVisible: true
        )
    }

    var body: some View {
        ConversationTitleActionsControl(
            presentation: presentation,
            onCopy: onCopy,
            onForkConversation: onForkConversation,
            onPin: onPin,
            onUnpin: onUnpin,
            onArchive: onArchive,
            onRename: onRename,
            onOpenForkParent: onOpenForkParent,
            onAnalyzeConversation: onAnalyzeConversation,
            onRefresh: onRefresh,
            onOpenInNewWindow: onOpenInNewWindow
        )
        .padding(.horizontal, 120)
        .offset(x: isSettingsOpen ? 0 : ((sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth) + 16) / 2)
        .animation(VAnimation.panel, value: sidebarExpanded)
    }
}
