import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers
import os

private let panelCoordinatorLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "PanelCoordinator"
)

private enum CostAssistantPrompt {
    static let analyze = [
        "Please load the llm-cost-optimizer skill.",
        "Analyze my recent LLM usage and explain the biggest cost contributors by call site, model, and profile.",
        "Check my current llm.default, llm.callSites, and llm.profiles.",
        "Give me a concise summary of what is driving cost and what you would optimize first.",
        "Do not change config yet.",
    ].joined(separator: " ")

    static let optimize = [
        "Please load the llm-cost-optimizer skill.",
        "Analyze my recent LLM usage and current LLM config, then recommend the safest cost-optimization changes.",
        "If changes are clearly safe, show me the exact config commands you would run and ask for confirmation before applying them.",
    ].joined(separator: " ")
}

// MARK: - Panel Coordination Extension

extension MainWindowView {
    /// Current conversation being rendered by `chatView`.
    private var renderedConversationIdForChatSurface: UUID? {
        conversationManager.activeConversationId ?? conversationManager.draftLocalId
    }

    /// True while the chat surface should show a loading skeleton instead of
    /// rendering a stale or partially-initialized conversation.
    private func shouldShowConversationSwitchSkeleton() -> Bool {
        guard let targetConversationId = pendingConversationSwitchId else { return false }
        guard renderedConversationIdForChatSurface == targetConversationId else {
            // Explicit switch pending but ConversationManager has not activated yet.
            return true
        }

        // Draft conversations are local-only and immediately ready.
        if conversationManager.activeConversationId == nil,
           conversationManager.draftLocalId == targetConversationId {
            return false
        }

        // Require the selected VM history to load before enabling interaction.
        // Use the active VM only (no cache/LRU mutations during body eval).
        guard let targetViewModel = conversationManager.activeViewModel else {
            return true
        }
        return !targetViewModel.isHistoryLoaded
    }

    // MARK: - Config-Driven Slot Rendering

    @ViewBuilder
    func slotView(for content: SlotContent) -> some View {
        switch content {
        case .native(let panelId): nativePanelView(panelId)
        case .surface(let surfaceId): surfaceSlotView(surfaceId: surfaceId)
        case .empty: EmptyView()
        }
    }

    @ViewBuilder
    func nativePanelView(_ panelId: NativePanelId) -> some View {
        switch panelId {
        case .chat:
            chatView
        case .settings:
            SettingsPanel(onClose: { windowState.navigateBackOrDismiss() }, store: settingsStore, connectionManager: connectionManager, conversationManager: conversationManager, authManager: authManager, assistantFeatureFlagStore: assistantFeatureFlagStore, bookmarkStore: bookmarkStore, showToast: { msg, style in windowState.showToast(message: msg, style: style) }, onEnableIntegration: {
                    conversationManager.openConversation(
                        message: "I'd like to enable an oauth integration. What integrations are available for me to connect to?",
                        forceNew: true
                    )
                    if let id = conversationManager.activeConversationId {
                        windowState.selection = .conversation(id)
                    } else {
                        windowState.selection = nil
                    }
                })
        case .logsAndUsage:
            LogsAndUsagePanel(
                traceStore: traceStore,
                connectionManager: connectionManager,
                activeSessionId: conversationManager.activeViewModel?.conversationId,
                usageDashboardStore: usageDashboardStore,
                onClose: { windowState.navigateBackOrDismiss() },
                onSelectConversation: { conversationId in
                    Task { @MainActor in
                        let found = await conversationManager.selectConversationByConversationIdAsync(conversationId)
                        guard found, let id = conversationManager.activeConversationId else { return }
                        windowState.selection = .conversation(id)
                    }
                },
                onAnalyzeCosts: {
                    openCostAssistantConversation(message: CostAssistantPrompt.analyze)
                },
                onOptimizeCosts: {
                    openCostAssistantConversation(message: CostAssistantPrompt.optimize)
                }
            )
        case .generated:
            GeneratedPanel(
                onClose: { sharing.showSharePicker = false; windowState.closeDynamicPanel() },
                isExpanded: Binding(
                    get: { windowState.isDynamicExpanded },
                    set: { windowState.isDynamicExpanded = $0 }
                ),
                connectionManager: connectionManager,
                eventStreamClient: eventStreamClient,
                gatewayBaseURL: settingsStore.localGatewayTarget,
                onOpenApp: { surfaceMsg in
                    windowState.activeDynamicSurface = surfaceMsg
                    windowState.activeDynamicParsedSurface = Surface.from(surfaceMsg)
                },
                onRecordAppOpen: { id, name, icon, appType in
                    appListManager.recordAppOpen(id: id, name: name, icon: icon, appType: appType)
                }
            )
        case .conversationList:
            sidebarView
        case .avatarCustomization:
            AvatarCustomizationPanel(onClose: { windowState.selection = .panel(windowState.avatarCustomizationReturnPanel) })
        case .apps:
            AppsGridView(
                appListManager: appListManager,
                connectionManager: connectionManager,
                gatewayBaseURL: settingsStore.localGatewayTarget,
                onOpenApp: { appId in
                    Task { await AppsClient.openAppAndDispatchSurface(id: appId, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
                    windowState.selection = .app(appId)
                },
                onOpenSharedApp: { surfaceMsg in

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
                onNewConversation: {
                    startNewConversation()
                }
            )
        case .intelligence:
            IntelligencePanel(
                onClose: { windowState.navigateBackOrDismiss() },
                onInvokeSkill: { skill in
                    let vm = conversationManager.openConversation(message: "Use the \(skill.name) skill") { vm in
                        vm.pendingSkillInvocation = SkillInvocationData(
                            name: skill.name,
                            emoji: skill.emoji,
                            description: skill.description
                        )
                    }
                    vm?.pendingSkillInvocation = nil
                    windowState.selection = nil
                },
                onCreateSkill: {
                    conversationManager.openConversation(
                        message: "I'd like to create a new custom skill. What info do you need from me?",
                        forceNew: true
                    )
                    if let id = conversationManager.activeConversationId {
                        windowState.selection = .conversation(id)
                    } else {
                        windowState.selection = nil
                    }
                },
                onImportMemory: { message in
                    conversationManager.openConversation(message: message, forceNew: true)
                    if let id = conversationManager.activeConversationId {
                        windowState.selection = .conversation(id)
                    } else {
                        windowState.selection = nil
                    }
                },
                connectionManager: connectionManager,
                eventStreamClient: eventStreamClient,
                store: settingsStore,
                conversationManager: conversationManager,
                authManager: authManager,
                showToast: { msg, style in windowState.showToast(message: msg, style: style) },
                initialTab: windowState.pendingIntelligenceTab ?? (windowState.pendingSkillId != nil ? "Skills" : nil),
                pendingTab: $windowState.pendingIntelligenceTab,
                pendingSkillId: $windowState.pendingSkillId
            )
        case .home:
            homeContentView(onDismiss: { windowState.selection = nil })
        case .acpSessions:
            if CodingAgentsPanelFeatureFlag.isEnabled {
                ACPSessionsPanel(
                    store: acpSessionStore,
                    activeConversationId: conversationManager.activeConversationId?.uuidString,
                    onClose: { windowState.hideRightSlot(.acpSessions) }
                )
            }
        }
    }

    // MARK: - Home Panel (VSplitView)

    @ViewBuilder
    func homeContentView(onDismiss: @escaping () -> Void) -> some View {
        HomePageView(
            store: homeStore,
            feedStore: feedStore,
            meetStatusViewModel: meetStatusViewModel,
            onFeedConversationOpened: { daemonConversationId in
                Task { @MainActor in
                    let found = await conversationManager.selectConversationByConversationIdAsync(daemonConversationId)
                    let activeLocalId = conversationManager.activeConversationId
                    panelCoordinatorLog.info(
                        "HomeFeed: opened conversation daemonConversationId=\(daemonConversationId, privacy: .public) found=\(found, privacy: .public) activeLocalId=\(activeLocalId?.uuidString ?? "<nil>", privacy: .public)"
                    )
                    guard found, let id = activeLocalId else {
                        windowState.showToast(message: "Couldn't open the conversation.", style: .error)
                        return
                    }
                    activeHomeDetailPanel = nil
                    onDismiss()
                    windowState.selection = .conversation(id)
                }
            },
            onStartNewChat: {
                activeHomeDetailPanel = nil
                onDismiss()
                startNewConversation()
            },
            onDismissSuggestions: {},
            onSuggestionSelected: { suggestion in
                activeHomeDetailPanel = nil
                conversationManager.openConversation(message: suggestion.prompt, forceNew: true)
                onDismiss()
                if let id = conversationManager.activeConversationId {
                    windowState.selection = .conversation(id)
                }
            },
            onDetailPanelSelected: { item in
                activeHomeDetailPanel = HomeDetailPanelKind.resolve(for: item)
            }
        )
        .onAppear { homeStore.setHomeTabVisible(true) }
        .onDisappear {
            homeStore.setHomeTabVisible(false)
            activeHomeDetailPanel = nil
        }
    }

    @ViewBuilder
    func homeDetailPanelContent() -> some View {
        switch activeHomeDetailPanel {
        case .toolPermission(let item):
            HomeDetailPanel(
                icon: nil,
                title: item.title,
                onClose: { activeHomeDetailPanel = nil }
            ) {
                HomePermissionDetailCard(item: item)
            }
        case .generic(let item):
            // Suppress the header title when it duplicates the summary —
            // defense in depth in case a future producer manufactures one.
            // The daemon already omits `title` when no source title was
            // supplied.
            let trimmedTitle = (item.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedSummary = item.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            let headerTitle: String? =
                trimmedTitle.isEmpty || trimmedTitle == trimmedSummary
                    ? nil
                    : item.title
            HomeDetailPanel(
                icon: iconForFeedItem(item),
                title: headerTitle,
                iconForeground: iconForegroundForFeedItem(item),
                iconBackground: iconBackgroundForFeedItem(item),
                onGoToConvo: goToConvoHandler(for: item),
                onMarkReadUnread: {
                    Task {
                        let nextStatus: FeedItemStatus = isItemRead(item) ? .new : .seen
                        await feedStore.updateStatus(itemId: item.id, status: nextStatus)
                    }
                },
                isRead: isItemRead(item),
                onDismissItem: {
                    Task {
                        await feedStore.dismiss(itemId: item.id)
                    }
                    activeHomeDetailPanel = nil
                },
                onClose: { activeHomeDetailPanel = nil },
                showsPersonaAvatar: item.fromAssistant == true
            ) {
                HomeMarkdownContent(text: item.summary)
                    .padding(VSpacing.lg)
            }
        case nil:
            EmptyView()
        }
    }

    /// Whether the feed item is in a "read" state (`seen` or `actedOn`).
    private func isItemRead(_ item: FeedItem) -> Bool {
        let current = feedStore.items.first(where: { $0.id == item.id })
        let status = current?.status ?? item.status
        return status == .seen || status == .actedOn
    }

    /// Builds the "Go to Convo" handler for the home detail panel.
    ///
    /// `FeedItem.conversationId` carries the **daemon-side** conversation
    /// ID (mirrored from `notification_intent.deepLinkMetadata.conversationId`
    /// and `notification_deliveries.conversation_id`). `ViewSelection`'s
    /// `.conversation(UUID)` requires the **client-local** `ConversationModel.id`,
    /// which is a separately generated UUID — same shape, different namespace.
    /// We must round-trip through `selectConversationByConversationIdAsync(_:)`
    /// to resolve the daemon ID to the matching local model (fetching on
    /// demand if it isn't in the sidebar yet), then drive selection off the
    /// resolved local UUID. The same pattern is used by the logs panel's
    /// `onSelectConversation` callback above.
    ///
    /// Returns `nil` when the feed item has no associated conversation —
    /// `HomeDetailPanel` hides the button when the handler is `nil`.
    private func goToConvoHandler(for item: FeedItem) -> (() -> Void)? {
        guard let daemonConversationId = item.conversationId else { return nil }
        return {
            Task { @MainActor in
                let found = await conversationManager.selectConversationByConversationIdAsync(daemonConversationId)
                let activeLocalId = conversationManager.activeConversationId
                panelCoordinatorLog.info(
                    "Go to Convo: daemonConversationId=\(daemonConversationId, privacy: .public) feedItemId=\(item.id, privacy: .public) found=\(found, privacy: .public) activeLocalId=\(activeLocalId?.uuidString ?? "<nil>", privacy: .public)"
                )
                guard found, let id = activeLocalId else {
                    windowState.showToast(message: "Couldn't open the conversation.", style: .error)
                    return
                }
                activeHomeDetailPanel = nil
                windowState.selection = .conversation(id)
            }
        }
    }

    func clampedHomeDetailPanelWidth(windowSize: CGSize) -> Binding<Double> {
        let settingsOpen: Bool = {
            if case .panel(.settings) = windowState.selection { return true }
            if case .panel(.logsAndUsage) = windowState.selection { return true }
            return false
        }()
        let sidebarWidth: CGFloat = settingsOpen ? 0 : (sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth)
        let hstackSpacing: CGFloat = 16
        let outerPadding: CGFloat = 32
        let windowWidth: Double = Double(windowSize.width) / zoomManager.zoomLevel
        let availableWidth: Double = windowWidth - Double(sidebarWidth) - Double(hstackSpacing) - Double(outerPadding)

        let preferredMinPanel: Double = 300
        let preferredMinMain: Double = 300
        let dividerBudget: Double = Double(VSpacing.xs) + 12
        let maxPanel: Double = availableWidth - preferredMinMain - dividerBudget
        let effectiveMinPanel: Double = min(preferredMinPanel, max(maxPanel, 100))

        return Binding<Double>(
            get: {
                let raw = homeDetailPanelWidth
                return min(max(raw, effectiveMinPanel), max(maxPanel, effectiveMinPanel))
            },
            set: {
                homeDetailPanelWidth = min(max($0, effectiveMinPanel), max(maxPanel, effectiveMinPanel))
            }
        )
    }

    @ViewBuilder
    func surfaceSlotView(surfaceId: String) -> some View {
        if let surface = surfaceManager.activeSurfaces[surfaceId],
           case .dynamicPage(let dpData) = surface.data {
            DynamicPageSurfaceView(
                data: dpData,
                onAction: { actionId, actionData in
                    if !windowState.isChatDockOpen {
                        let appId = dpData.appId ?? surfaceId
                        enterAppEditing(appId: appId)
                    }
                    // Route relay_prompt actions directly as chat messages so they
                    // reach the active conversation instead of being lost when the surface
                    // was opened outside a conversation context (e.g. via app_open).
                    if actionId == "relay_prompt" || actionId == "agent_prompt",
                       let dataDict = actionData as? [String: Any],
                       let prompt = dataDict["prompt"] as? String,
                       !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        // Ensure a conversation exists so the prompt doesn't silently fail
                        // on fresh app launch before any chat conversation is created.
                        conversationManager.openConversation(
                            message: prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                        ) { vm in
                            // Sync dock state before sending so the message is
                            // classified correctly (chat vs. workspace refinement).
                            vm.isChatDockedToSide = windowState.isChatDockOpen
                        }
                        return
                    }
                    surfaceManager.onAction?(surface.conversationId, surface.id, actionId, actionData as? [String: Any])
                },
                onLinkOpen: { url, metadata in
                    surfaceManager.onLinkOpen?(url, metadata)
                }
            )
        } else {
            VStack {
                Spacer()
                Text("Surface not available")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.surfaceOverlay)
        }
    }

    // MARK: - Split-Width Helpers

    /// Computes a clamped panel-width binding for split layouts, accounting for
    /// sidebar consumption and enforcing min main/panel constraints on both
    /// get and set paths so persisted values stay valid across resizes.
    func clampedPanelWidth(windowSize: CGSize) -> Binding<Double> {
        // Sidebar sits in the HStack and consumes real width.
        // When settings is open the sidebar is hidden.
        let settingsOpen: Bool = {
            if case .panel(.settings) = windowState.selection { return true }
            if case .panel(.logsAndUsage) = windowState.selection { return true }
            return false
        }()
        let sidebarWidth: CGFloat = settingsOpen ? 0 : (sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth)
        let hstackSpacing: CGFloat = 16
        let outerPadding: CGFloat = 32 // 16 left + 16 right
        let windowWidth: Double = Double(windowSize.width) / zoomManager.zoomLevel
        let availableWidth: Double = windowWidth - Double(sidebarWidth) - Double(hstackSpacing) - Double(outerPadding)

        let preferredMinPanel: Double = 300
        let preferredMinMain: Double = 300
        // VSplitView internals: leading padding (xs=4) + divider (8) = 12
        let dividerBudget: Double = Double(VSpacing.xs) + 12
        let maxPanel: Double = availableWidth - preferredMinMain - dividerBudget
        // When the window is too narrow, allow the panel to shrink below the
        // preferred minimum so the main pane isn't crushed below its minimum.
        let effectiveMinPanel: Double = min(preferredMinPanel, max(maxPanel, 100))

        return Binding<Double>(
            get: {
                let raw = appPanelWidth > 0 ? appPanelWidth : availableWidth * 0.7
                return min(max(raw, effectiveMinPanel), max(maxPanel, effectiveMinPanel))
            },
            set: {
                appPanelWidth = min(max($0, effectiveMinPanel), max(maxPanel, effectiveMinPanel))
            }
        )
    }

    /// Clamped binding for the side panel (config/subagent panel) so persisted
    /// or default widths can't crush the main chat pane below its minimum.
    func clampedSidePanelWidth(windowSize: CGSize) -> Binding<Double> {
        let settingsOpen: Bool = {
            if case .panel(.settings) = windowState.selection { return true }
            if case .panel(.logsAndUsage) = windowState.selection { return true }
            return false
        }()
        let sidebarWidth: CGFloat = settingsOpen ? 0 : (sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth)
        let hstackSpacing: CGFloat = 16
        let outerPadding: CGFloat = 32
        let windowWidth: Double = Double(windowSize.width) / zoomManager.zoomLevel
        let availableWidth: Double = windowWidth - Double(sidebarWidth) - Double(hstackSpacing) - Double(outerPadding)

        let preferredMinPanel: Double = 300
        let preferredMinMain: Double = 300
        let dividerBudget: Double = Double(VSpacing.xs) + 12
        let maxPanel: Double = availableWidth - preferredMinMain - dividerBudget
        let effectiveMinPanel: Double = min(preferredMinPanel, max(maxPanel, 100))

        return Binding<Double>(
            get: {
                let raw = sidePanelWidth
                return min(max(raw, effectiveMinPanel), max(maxPanel, effectiveMinPanel))
            },
            set: {
                sidePanelWidth = min(max($0, effectiveMinPanel), max(maxPanel, effectiveMinPanel))
            }
        )
    }

    func clampedChatDockWidth(windowSize: CGSize) -> Binding<Double> {
        let settingsOpen: Bool = {
            if case .panel(.settings) = windowState.selection { return true }
            if case .panel(.logsAndUsage) = windowState.selection { return true }
            return false
        }()
        let sidebarWidth: CGFloat = settingsOpen ? 0 : (sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth)
        let hstackSpacing: CGFloat = 16
        let outerPadding: CGFloat = 32
        let windowWidth: Double = Double(windowSize.width) / zoomManager.zoomLevel
        let availableWidth: Double = windowWidth - Double(sidebarWidth) - Double(hstackSpacing) - Double(outerPadding)

        let preferredMin: Double = 300
        let dividerBudget: Double = Double(VSpacing.xs) + 12
        let maxDock: Double = availableWidth - 300 - dividerBudget
        let effectiveMin: Double = min(preferredMin, max(maxDock, 100))

        return Binding<Double>(
            get: {
                let raw = appChatDockWidth > 0 ? appChatDockWidth : availableWidth * 0.4
                return min(max(raw, effectiveMin), max(maxDock, effectiveMin))
            },
            set: {
                appChatDockWidth = min(max($0, effectiveMin), max(maxDock, effectiveMin))
            }
        )
    }

    @ViewBuilder
    func chatContentView(windowSize: CGSize) -> some View {
        switch windowState.selection {
        case .conversation:
            // Show chat for this conversation (conversationManager.activeViewModel is synced)
            defaultChatLayout(windowSize: windowSize)
        case .app(let appId), .appEditing(let appId, _):
            if let surface = windowState.activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data {
                VAppWorkspaceDockLayout(
                    dockWidth: clampedChatDockWidth(windowSize: windowSize),
                    showDock: windowState.isChatDockOpen,
                    dockBackground: VColor.surfaceOverlay,
                    dockCornerRadius: 0,
                    dock: {
                        chatView
                    },
                    workspace: {
                        dynamicWorkspaceView(surface: surface, data: dpData)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    }
                )
            } else {
                AppLoadingView(
                    appId: appId,
                    onRetry: { appId in
                        Task { await AppsClient.openAppAndDispatchSurface(id: appId, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
                    },
                    onClose: {
                        windowState.closeDynamicPanel()
                    }
                )
                .id(appId)
            }
        case .panel(let panelType):
            if panelType == .apps {
                AppsGridView(
                    appListManager: appListManager,
                    connectionManager: connectionManager,
                    gatewayBaseURL: settingsStore.localGatewayTarget,
                    onOpenApp: { appId in
                        Task { await AppsClient.openAppAndDispatchSurface(id: appId, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
                        windowState.selection = .app(appId)
                    },
                    onOpenSharedApp: { surfaceMsg in
    
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
                    onNewConversation: {
                        startNewConversation()
                    }
                )
                    .background(VColor.surfaceBase)
            } else if panelType == .documentEditor {
                let config = windowState.layoutConfig
                VSplitView(
                    panelWidth: clampedSidePanelWidth(windowSize: windowSize),
                    showPanel: documentManager.hasActiveDocument,
                    main: { slotView(for: config.center.content) },
                    panel: {
                        DocumentEditorPanelView(
                            documentManager: documentManager,
                            connectionManager: connectionManager,
                            onClose: { windowState.selection = nil; documentManager.closeDocument() }
                        )
                    }
                )
                .onAppear {
                    conversationManager.ensureActiveConversation(preferredConversationId: documentManager.conversationId)
                }
            } else if panelType == .home {
                VSplitView(
                    panelWidth: clampedHomeDetailPanelWidth(windowSize: windowSize),
                    showPanel: activeHomeDetailPanel != nil,
                    main: {
                        homeContentView(onDismiss: { windowState.selection = nil })
                    },
                    panel: {
                        homeDetailPanelContent()
                    }
                )
            } else if isAppChatOpen {
                // Split view: chat (left) + panel (right)
                VSplitView(
                    panelWidth: clampedPanelWidth(windowSize: windowSize),
                    showPanel: true,
                    mainBackground: VColor.surfaceOverlay,
                    mainCornerRadius: 0,
                    main: {
                        chatView
                    },
                    panel: {
                        fullWindowPanel(panelType)
                            .clipShape(UnevenRoundedRectangle(topLeadingRadius: VRadius.xl, bottomLeadingRadius: VRadius.xl))
                    }
                )
                .onAppear {
                    conversationManager.ensureActiveConversation()
                }
            } else {
                // Full-window panels: settings, logs & usage, intelligence
                fullWindowPanel(panelType)
            }
        case nil:
            // Default: show chat for active conversation
            defaultChatLayout(windowSize: windowSize)
        }
    }

    /// The default chat layout used when showing a conversation or no specific selection.
    @ViewBuilder
    func defaultChatLayout(windowSize: CGSize) -> some View {
        let config = windowState.layoutConfig
        let isDisabledACPSessionsRightSlot = Self.isDisabledACPSessionsRightSlot(config.right)
        let showConfigPanel = config.right.visible && config.right.content != .empty && !isDisabledACPSessionsRightSlot
        let isSwitchingConversation = shouldShowConversationSwitchSkeleton()
        let showSubagentPanel = !isSwitchingConversation
            && windowState.selectedSubagentId != nil
            && conversationManager.activeViewModel != nil

        VSplitView(
            panelWidth: clampedSidePanelWidth(windowSize: windowSize),
            showPanel: showConfigPanel || showSubagentPanel,
            mainBackground: VColor.surfaceOverlay,
            mainCornerRadius: 0,
            main: { slotView(for: config.center.content) },
            panel: {
                if !isSwitchingConversation,
                   let subagentId = windowState.selectedSubagentId,
                   let viewModel = conversationManager.activeViewModel {
                    SubagentDetailPanel(
                        subagentId: subagentId,
                        viewModel: viewModel,
                        detailStore: viewModel.subagentDetailStore,
                        showInspectButton: MacOSClientFeatureFlagManager.shared.isEnabled("settings-developer-nav"),
                        onAbort: { Task { await viewModel.abortSubagent(subagentId) } },
                        onRequestDetail: {
                            if let conversationId = viewModel.activeSubagents.first(where: { $0.id == subagentId })?.conversationId {
                                Task { @MainActor in
                                    try? await Task.sleep(for: .milliseconds(100))
                                    if let response = await SubagentClient().fetchDetail(subagentId: subagentId, conversationId: conversationId) {
                                        viewModel.subagentDetailStore.populateFromDetailResponse(response)
                                    }
                                }
                            }
                        },
                        onInspectMessage: { messageId in
                            withAnimation(VAnimation.standard) {
                                windowState.inspectorMessageId = messageId
                            }
                        },
                        onClose: {
                            var t = Transaction()
                            t.disablesAnimations = true
                            withTransaction(t) { windowState.selectedSubagentId = nil }
                        }
                    )
                    .id(subagentId)
                } else {
                    slotView(for: config.right.content)
                }
            }
        )
        .onAppear {
            hideDisabledACPSessionsRightSlotIfNeeded(config.right)
        }
        .onChange(of: config.right) { _, rightSlot in
            hideDisabledACPSessionsRightSlotIfNeeded(rightSlot)
        }
    }

    static func isDisabledACPSessionsRightSlot(_ rightSlot: SlotConfig) -> Bool {
        !CodingAgentsPanelFeatureFlag.isEnabled
            && rightSlot.visible
            && rightSlot.content == .native(.acpSessions)
    }

    private func hideDisabledACPSessionsRightSlotIfNeeded(_ rightSlot: SlotConfig) {
        guard Self.isDisabledACPSessionsRightSlot(rightSlot) else { return }
        Task { @MainActor in
            windowState.hideRightSlot(.acpSessions)
        }
    }

    @ViewBuilder
    var chatView: some View {
        if shouldShowConversationSwitchSkeleton() {
            ConversationSwitchLoadingView()
        } else if let viewModel = conversationManager.activeViewModel {
            let activeConversation = conversationManager.activeConversation
            let conversationStartersEnabled = true
            let showInspectButton = MacOSClientFeatureFlagManager.shared.isEnabled(
                "settings-developer-nav"
            )
            let isTTSEnabled = assistantFeatureFlagStore.isEnabled(
                "message-tts"
            )
            let isVoiceModeEnabled = assistantFeatureFlagStore.isEnabled(
                "voice-mode"
            )
            let showThresholdPicker = true
            ActiveChatViewWrapper(
                viewModel: viewModel,
                windowState: windowState,
                conversationStartersEnabled: conversationStartersEnabled,
                showThresholdPicker: showThresholdPicker,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                ambientAgent: ambientAgent,
                settingsStore: settingsStore,
                conversationManager: conversationManager,
                bookmarkStore: bookmarkStore,
                diskPressureStatusStore: diskPressureStatusStore,
                onMicrophoneToggle: onMicrophoneToggle,
                isReadonly: activeConversation?.isChannelConversation ?? false,
                voiceModeManager: voiceModeManager,
                voiceService: voiceModeManager.openAIVoiceService,
                onEndVoiceMode: {
                    voiceModeManager.deactivate()
                },
                onDictateToggle: {
                    AppDelegate.shared?.voiceInput?.toggleRecording(origin: .chatComposer)
                },
                onVoiceModeToggle: isVoiceModeEnabled ? {
                    toggleVoiceMode()
                } : nil,
                onOpenConversationApp: { [connectionManager, eventStreamClient] artifact in
                    guard let appId = artifact.appId else { return }
                    Task {
                        await AppsClient.openAppAndDispatchSurface(
                            id: appId,
                            connectionManager: connectionManager,
                            eventStreamClient: eventStreamClient
                        )
                    }
                },
                onOpenConversationDocument: { artifact in
                    guard let surfaceId = artifact.surfaceId else { return }
                    NotificationCenter.default.post(
                        name: .openDocumentEditor,
                        object: nil,
                        userInfo: ["documentSurfaceId": surfaceId]
                    )
                },
                conversationId: conversationManager.activeConversationId ?? conversationManager.draftLocalId,
                anchorMessageId: $conversationManager.pendingAnchorMessageId,
                anchorDaemonMessageId: $conversationManager.pendingAnchorDaemonMessageId,
                highlightedMessageId: $conversationManager.highlightedMessageId,
                isInteractionEnabled: viewModel.isHistoryLoaded
            )
        }
    }

    private func openCostAssistantConversation(message: String) {
        conversationManager.openConversation(message: message, forceNew: true)
        if let id = conversationManager.activeConversationId {
            windowState.selection = .conversation(id)
        } else {
            windowState.selection = nil
        }
    }

    @ViewBuilder
    func fullWindowPanel(_ panel: SidePanelType) -> some View {
        switch panel {
        case .settings:
            SettingsPanel(onClose: { windowState.navigateBackOrDismiss() }, store: settingsStore, connectionManager: connectionManager, conversationManager: conversationManager, authManager: authManager, assistantFeatureFlagStore: assistantFeatureFlagStore, bookmarkStore: bookmarkStore, showToast: { msg, style in windowState.showToast(message: msg, style: style) }, onEnableIntegration: {
                    conversationManager.openConversation(
                        message: "I'd like to enable an oauth integration. What integrations are available for me to connect to?",
                        forceNew: true
                    )
                    if let id = conversationManager.activeConversationId {
                        windowState.selection = .conversation(id)
                    } else {
                        windowState.selection = nil
                    }
                })
        case .logsAndUsage:
            LogsAndUsagePanel(
                traceStore: traceStore,
                connectionManager: connectionManager,
                activeSessionId: conversationManager.activeViewModel?.conversationId,
                usageDashboardStore: usageDashboardStore,
                onClose: { windowState.navigateBackOrDismiss() },
                onSelectConversation: { conversationId in
                    Task { @MainActor in
                        let found = await conversationManager.selectConversationByConversationIdAsync(conversationId)
                        guard found, let id = conversationManager.activeConversationId else { return }
                        windowState.selection = .conversation(id)
                    }
                },
                onAnalyzeCosts: {
                    openCostAssistantConversation(message: CostAssistantPrompt.analyze)
                },
                onOptimizeCosts: {
                    openCostAssistantConversation(message: CostAssistantPrompt.optimize)
                }
            )
        case .avatarCustomization:
            AvatarCustomizationPanel(onClose: { windowState.selection = .panel(windowState.avatarCustomizationReturnPanel) })
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
        case .apps:
            AppsGridView(
                appListManager: appListManager,
                connectionManager: connectionManager,
                gatewayBaseURL: settingsStore.localGatewayTarget,
                onOpenApp: { appId in
                    Task { await AppsClient.openAppAndDispatchSurface(id: appId, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
                    windowState.selection = .app(appId)
                },
                onOpenSharedApp: { surfaceMsg in

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
                onNewConversation: {
                    startNewConversation()
                }
            )
        case .intelligence:
            IntelligencePanel(
                onClose: { windowState.navigateBackOrDismiss() },
                onInvokeSkill: { skill in
                    let vm = conversationManager.openConversation(message: "Use the \(skill.name) skill") { vm in
                        vm.pendingSkillInvocation = SkillInvocationData(
                            name: skill.name,
                            emoji: skill.emoji,
                            description: skill.description
                        )
                    }
                    vm?.pendingSkillInvocation = nil
                    windowState.dismissOverlay()
                },
                onCreateSkill: {
                    conversationManager.openConversation(
                        message: "I'd like to create a new custom skill. What info do you need from me?",
                        forceNew: true
                    )
                    windowState.dismissOverlay()
                    if let id = conversationManager.activeConversationId {
                        windowState.selection = .conversation(id)
                    }
                },
                onImportMemory: { message in
                    conversationManager.openConversation(message: message, forceNew: true)
                    windowState.dismissOverlay()
                    if let id = conversationManager.activeConversationId {
                        windowState.selection = .conversation(id)
                    }
                },
                connectionManager: connectionManager,
                eventStreamClient: eventStreamClient,
                store: settingsStore,
                conversationManager: conversationManager,
                authManager: authManager,
                showToast: { msg, style in windowState.showToast(message: msg, style: style) },
                initialTab: windowState.pendingIntelligenceTab ?? (windowState.pendingSkillId != nil ? "Skills" : nil),
                pendingTab: $windowState.pendingIntelligenceTab,
                pendingSkillId: $windowState.pendingSkillId
            )
        case .home:
            homeContentView(onDismiss: { windowState.dismissOverlay() })
        }
    }

    // MARK: - Dynamic Workspace

    @ViewBuilder
    func dynamicWorkspaceView(surface: Surface, data: DynamicPageSurfaceData) -> some View {
        if let viewModel = conversationManager.activeViewModel {
            DynamicWorkspaceWrapper(
                viewModel: viewModel,
                surface: surface,
                data: data,
                windowState: windowState,
                surfaceManager: surfaceManager,
                connectionManager: connectionManager,
                trafficLightPadding: trafficLightPadding,
                isSidebarOpen: sidebarExpanded,
                sharing: sharing,
                gatewayBaseURL: settingsStore.localGatewayTarget,
                onPublishPage: publishPage,
                onBundleAndShare: bundleAndShare,
                isChatDockOpen: windowState.isChatDockOpen,
                onToggleChatDock: {
                    withAnimation(VAnimation.panel) {
                        if case .appEditing(let appId, _) = windowState.selection {
                            exitAppEditing(appId: appId)
                        } else if case .app(let appId) = windowState.selection {
                            enterAppEditing(appId: appId)
                        }
                    }
                },
                onMicrophoneToggle: onMicrophoneToggle
            )
        }
    }
}

// MARK: - Feed Item Icon Helpers

/// Icon glyph for a feed item in the detail panel, dispatched per
/// `FeedItemCategory`. Falls back to `.bell` for items without a category.
private func iconForFeedItem(_ item: FeedItem) -> VIcon {
    switch item.category {
    case .security:    return .shieldCheck
    case .email:       return .mail
    case .scheduling:  return .clock
    case .background:  return .settings
    case .system:      return .bell
    case nil:          return .bell
    }
}

/// Foreground (glyph) color for the detail-panel recap icon, dispatched
/// per `FeedItemCategory`.
private func iconForegroundForFeedItem(_ item: FeedItem) -> Color {
    switch item.category {
    case .security:    return VColor.feedNudgeStrong
    case .email:       return VColor.feedDigestStrong
    case .scheduling:  return VColor.feedThreadStrong
    case .background:  return VColor.systemInfoStrong
    case .system:      return VColor.feedDigestStrong
    case nil:          return VColor.feedDigestStrong
    }
}

/// Background (circle fill) color for the detail-panel recap icon,
/// dispatched per `FeedItemCategory`.
private func iconBackgroundForFeedItem(_ item: FeedItem) -> Color {
    switch item.category {
    case .security:    return VColor.feedNudgeWeak
    case .email:       return VColor.feedDigestWeak
    case .scheduling:  return VColor.feedThreadWeak
    case .background:  return VColor.systemInfoWeak
    case .system:      return VColor.feedDigestWeak
    case nil:          return VColor.feedDigestWeak
    }
}

// MARK: - Wrapper Views

/// Renders the chat interface with an optional message inspector overlay.
/// Owns bootstrap-state reading; ChatView reads viewModel properties directly
/// via @Bindable. Inspector state is shared via `MainWindowState.inspectorMessageId`
/// so both the chat and the subagent panel can trigger it.
struct ActiveChatViewWrapper: View {
    @Bindable var viewModel: ChatViewModel
    var windowState: MainWindowState
    let conversationStartersEnabled: Bool
    var showThresholdPicker: Bool = false
    var showInspectButton: Bool = false
    var isTTSEnabled: Bool = false
    var ambientAgent: AmbientAgent
    @ObservedObject var settingsStore: SettingsStore
    let conversationManager: ConversationManager
    let bookmarkStore: BookmarkStore
    let diskPressureStatusStore: DiskPressureStatusStore
    let onMicrophoneToggle: () -> Void
    var isReadonly: Bool = false
    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var onOpenConversationApp: ((ConversationArtifact) -> Void)? = nil
    var onOpenConversationDocument: ((ConversationArtifact) -> Void)? = nil
    var conversationId: UUID?
    @Binding var anchorMessageId: UUID?
    /// Daemon (server-side) message ID to anchor on. Forwarded from
    /// `ConversationSelectionStore.pendingAnchorDaemonMessageId` so deep
    /// links from settings panes (e.g. Bookmarks) can scroll to a message
    /// without first knowing its client-generated `UUID`.
    @Binding var anchorDaemonMessageId: String?
    @Binding var highlightedMessageId: UUID?
    var isInteractionEnabled: Bool = true

    /// Reads the persisted bootstrap state so the chat view can suppress
    /// the empty state during first-launch bootstrap.
    @AppStorage("bootstrapState") private var bootstrapStateRaw: String = "complete"
    private var isBootstrapping: Bool { bootstrapStateRaw != "complete" }
    private var isBootstrapTimedOut: Bool { bootstrapStateRaw == "timedOut" }

    var body: some View {
        ZStack {
            ChatView(
                viewModel: viewModel,
                selectedModel: settingsStore.selectedModel,
                configuredProviders: settingsStore.configuredProviders,
                providerCatalog: settingsStore.providerCatalog,
                mediaEmbedSettings: MediaEmbedResolverSettings(
                    enabled: settingsStore.mediaEmbedsEnabled,
                    enabledSince: settingsStore.mediaEmbedsEnabledSince,
                    allowedDomains: settingsStore.mediaEmbedVideoAllowlistDomains
                ),
                inferenceProfiles: settingsStore.profiles,
                activeInferenceProfile: settingsStore.activeProfile,
                onMicrophoneToggle: onMicrophoneToggle,
                onForkFromMessage: isReadonly ? nil : { [conversationManager] daemonMessageId in
                    Task { @MainActor in
                        await conversationManager.forkConversation(throughDaemonMessageId: daemonMessageId)
                    }
                },
                onInspectMessage: { presentInspector(for: $0) },
                onToggleBookmark: isReadonly ? nil : { [bookmarkStore] daemonMessageId, conversationId in
                    Task { @MainActor in
                        await bookmarkStore.toggle(messageId: daemonMessageId, conversationId: conversationId)
                    }
                },
                bookmarkStore: bookmarkStore,
                bookmarkConversationId: viewModel.conversationId,
                onSubagentTap: { id in
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) { windowState.selectedSubagentId = id }
                },
                onAddFunds: {
                    settingsStore.pendingSettingsTab = .billing
                    windowState.selection = .panel(.settings)
                },
                onOpenModelsAndServices: {
                    settingsStore.pendingSettingsTab = .modelsAndServices
                    windowState.selection = .panel(.settings)
                },
                safeStorageRequiresAcknowledgement: diskPressureStatusStore.requiresAcknowledgement,
                safeStorageCleanupState: SafeStorageCleanupStatusViewState(
                    status: diskPressureStatusStore.status,
                    isCleanupModeActive: diskPressureStatusStore.isCleanupModeActive
                ),
                onOpenStorageCleanup: {
                    windowState.showWorkspace()
                },
                onBootstrapSendLogs: {
                    AppDelegate.shared?.showLogReportWindow(reason: .bugReport)
                },
                onOpenConversationApp: onOpenConversationApp,
                onOpenConversationDocument: onOpenConversationDocument,
                recoveryMode: settingsStore.managedAssistantRecoveryMode,
                isRecoveryModeExiting: settingsStore.recoveryModeExiting,
                onResumeAssistant: {
                    settingsStore.exitManagedAssistantRecoveryMode()
                },
                onOpenSSHSettings: {
                    settingsStore.pendingSettingsTab = .developer
                    windowState.selection = .panel(.settings)
                },
                anchorMessageId: $anchorMessageId,
                anchorDaemonMessageId: $anchorDaemonMessageId,
                highlightedMessageId: $highlightedMessageId,
                conversationId: conversationId,
                isInteractionEnabled: isInteractionEnabled && windowState.inspectorMessageId == nil,
                isReadonly: isReadonly,
                isBootstrapping: isBootstrapping,
                isBootstrapTimedOut: isBootstrapTimedOut,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                conversationStartersEnabled: conversationStartersEnabled,
                voiceModeManager: voiceModeManager,
                voiceService: voiceService,
                onEndVoiceMode: onEndVoiceMode,
                onDictateToggle: onDictateToggle,
                onVoiceModeToggle: onVoiceModeToggle,
                watchSession: ambientAgent.activeWatchSession,
                conversationManager: conversationManager,
                showThresholdPicker: showThresholdPicker
            )
            .environment(\.cmdEnterToSend, settingsStore.cmdEnterToSend)
            .disabled(windowState.inspectorMessageId != nil || !isInteractionEnabled)

            if let messageId = windowState.inspectorMessageId {
                MessageInspectorView(
                    messageId: messageId,
                    onBack: dismissInspector
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
                .layoutHangSignpost("panel.messageInspector")
            }
        }
        .animation(VAnimation.standard, value: windowState.inspectorMessageId)
        .onDisappear {
            windowState.inspectorMessageId = nil
        }
        .onChange(of: conversationId) { _, _ in
            windowState.inspectorMessageId = nil
        }
    }

    private func presentInspector(for messageId: String?) {
        guard let messageId else { return }
        withAnimation(VAnimation.standard) {
            windowState.inspectorMessageId = messageId
        }
    }

    private func dismissInspector() {
        withAnimation(VAnimation.standard) {
            windowState.inspectorMessageId = nil
        }
    }
}

/// Immediate visual placeholder while switching conversations.
private struct ConversationSwitchLoadingView: View {
    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                ChatLoadingSkeleton()
                    .padding(VSpacing.lg)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Loading chat history")
                Spacer(minLength: 0)
            }
            Spacer(minLength: 0)
        }
            .background(VColor.surfaceBase)
    }
}

// MARK: - App Loading View

/// Shows a loading spinner while waiting for the daemon to send surface data,
/// with a timeout that transitions to an error state so the user isn't stuck
/// on an infinite spinner when the daemon fails to respond.
private struct AppLoadingView: View {
    let appId: String?
    let onRetry: (String) -> Void
    let onClose: () -> Void

    private static let timeoutSeconds: UInt64 = 8

    @State private var timedOut = false

    var body: some View {
        VStack(spacing: VSpacing.md) {
            Spacer()
            if timedOut {
                VIconView(.triangleAlert, size: 28)
                    .foregroundStyle(VColor.systemNegativeHover)
                Text("Failed to load app")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                Text("The app didn't respond in time. It may be unavailable or still starting up.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
                HStack(spacing: VSpacing.sm) {
                    if let appId {
                        VButton(label: "Retry", icon: "arrow.clockwise", style: .outlined) {
                            timedOut = false
                            onRetry(appId)
                        }
                        .controlSize(.small)
                    }
                    VButton(label: "Close", style: .outlined) {
                        onClose()
                    }
                    .controlSize(.small)
                }
                .padding(.top, VSpacing.xs)
            } else {
                ProgressView()
                    .controlSize(.regular)
                Text("Loading app\u{2026}")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(alignment: .topTrailing) {
            VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost) {
                onClose()
            }
            .padding(VSpacing.lg)
        }
        .task(id: timedOut) {
            guard !timedOut else { return }
            try? await Task.sleep(nanoseconds: Self.timeoutSeconds * 1_000_000_000)
            if !Task.isCancelled {
                timedOut = true
            }
        }
    }
}
