import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers
import os

private let panelCoordinatorLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "PanelCoordinator"
)

// MARK: - Panel Coordination Extension

extension MainWindowView {
    fileprivate static let conversationStartersFeatureFlagKey =
        "conversation-starters"

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
            SettingsPanel(onClose: { windowState.navigateBackOrDismiss() }, store: settingsStore, connectionManager: connectionManager, conversationManager: conversationManager, authManager: authManager, assistantFeatureFlagStore: assistantFeatureFlagStore, showToast: { msg, style in windowState.showToast(message: msg, style: style) }, onEnableIntegration: {
                    conversationManager.openConversation(
                        message: "I'd like to enable an oauth integration. What integrations are available for me to connect to?",
                        forceNew: true
                    )
                    withAnimation(VAnimation.panel) {
                        if let id = conversationManager.activeConversationId {
                            windowState.selection = .conversation(id)
                        } else {
                            windowState.selection = nil
                        }
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
                        withAnimation(VAnimation.panel) {
                            windowState.selection = .conversation(id)
                        }
                    }
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
                assistantFeatureFlagStore: assistantFeatureFlagStore,
                showToast: { msg, style in windowState.showToast(message: msg, style: style) },
                initialTab: windowState.pendingMemoryId != nil ? "Memories" : windowState.pendingSkillId != nil ? "Skills" : nil,
                pendingMemoryId: $windowState.pendingMemoryId,
                pendingSkillId: $windowState.pendingSkillId
            )
        case .home:
            homePanelView(onDismiss: { windowState.selection = nil })
        }
    }

    @ViewBuilder
    func homePanelView(onDismiss: @escaping () -> Void) -> some View {
        // Home intentionally skips ``VPageContainer`` — the redesigned
        // Home page has its own centered hero greeting, so a top-aligned
        // "Home" title would double up and steal vertical space from the
        // first scroll viewport. ``HomePageView`` paints its own full
        // background internally, so no outer chrome is needed here.
        HomePageView(
            store: homeStore,
            feedStore: feedStore,
            meetStatusViewModel: meetStatusViewModel,
            onPrimaryCTA: { capability in
                let seed = CapabilityCTAContext.setupSeedMessage(for: capability, kind: .primary)
                conversationManager.openConversation(message: seed, forceNew: true)
                onDismiss()
                if let id = conversationManager.activeConversationId {
                    windowState.selection = .conversation(id)
                }
            },
            onShortcutCTA: { capability in
                let seed = CapabilityCTAContext.setupSeedMessage(for: capability, kind: .shortcut)
                conversationManager.openConversation(message: seed, forceNew: true)
                onDismiss()
                if let id = conversationManager.activeConversationId {
                    windowState.selection = .conversation(id)
                }
            },
            onFeedConversationOpened: { conversationId in
                // Daemon already created the conversation in response to
                // `store.triggerAction`; the client just needs to navigate.
                // A non-UUID id here means the daemon returned something
                // the client contract does not allow — log loudly so the
                // regression is visible instead of silently dropping.
                guard let uuid = UUID(uuidString: conversationId) else {
                    panelCoordinatorLog.error(
                        "HomeFeed: daemon returned non-UUID conversationId \(conversationId, privacy: .public); cannot navigate"
                    )
                    windowState.showToast(message: "Couldn't open the conversation.", style: .error)
                    return
                }
                onDismiss()
                windowState.selection = .conversation(uuid)
            },
            onSubmitMessage: { message in
                // Home inline composer: start a brand-new conversation
                // pre-seeded with the user's text and navigate into it.
                // `forceNew: true` is critical — we always want the
                // Home composer to create a fresh thread rather than
                // append to whatever was last active.
                conversationManager.openConversation(message: message, forceNew: true)
                onDismiss()
                if let id = conversationManager.activeConversationId {
                    windowState.selection = .conversation(id)
                }
            }
        )
        .onAppear {
            homeStore.isHomeTabVisible = true
            homeStore.markSeen()
        }
        .onDisappear {
            homeStore.isHomeTabVisible = false
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
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
        let showConfigPanel = config.right.visible && config.right.content != .empty
        let showSubagentPanel = windowState.selectedSubagentId != nil && conversationManager.activeViewModel != nil

        VSplitView(
            panelWidth: clampedSidePanelWidth(windowSize: windowSize),
            showPanel: showConfigPanel || showSubagentPanel,
            mainBackground: VColor.surfaceOverlay,
            mainCornerRadius: 0,
            main: { slotView(for: config.center.content) },
            panel: {
                if let subagentId = windowState.selectedSubagentId,
                   let viewModel = conversationManager.activeViewModel {
                    SubagentDetailPanel(
                        subagentId: subagentId,
                        viewModel: viewModel,
                        detailStore: viewModel.subagentDetailStore,
                        showInspectButton: assistantFeatureFlagStore.isEnabled("settings-developer-nav"),
                        onAbort: { Task { await viewModel.abortSubagent(subagentId) } },
                        onRequestDetail: {
                            if let conversationId = viewModel.activeSubagents.first(where: { $0.id == subagentId })?.conversationId {
                                Task {
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
                        onClose: { windowState.selectedSubagentId = nil }
                    )
                    .id(subagentId)
                } else {
                    slotView(for: config.right.content)
                }
            }
        )
    }

    @ViewBuilder
    var chatView: some View {
        if let viewModel = conversationManager.activeViewModel {
            let activeConversation = conversationManager.activeConversation
            let conversationStartersEnabled = assistantFeatureFlagStore.isEnabled(
                Self.conversationStartersFeatureFlagKey
            )
            let showInspectButton = assistantFeatureFlagStore.isEnabled(
                "settings-developer-nav"
            )
            let isTTSEnabled = assistantFeatureFlagStore.isEnabled(
                "message-tts"
            )
            let isVoiceModeEnabled = assistantFeatureFlagStore.isEnabled(
                "voice-mode"
            )
            let showsConversationHostAccessControl = assistantFeatureFlagStore.isEnabled(
                "permission-controls-v2"
            )
            let showThresholdPicker = assistantFeatureFlagStore.isEnabled(
                "auto-approve-threshold-ui"
            )
            ActiveChatViewWrapper(
                viewModel: viewModel,
                windowState: windowState,
                conversationStartersEnabled: conversationStartersEnabled,
                showsConversationHostAccessControl: showsConversationHostAccessControl,
                showThresholdPicker: showThresholdPicker,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                ambientAgent: ambientAgent,
                settingsStore: settingsStore,
                conversationManager: conversationManager,
                onMicrophoneToggle: onMicrophoneToggle,
                isTemporaryChat: activeConversation?.kind == .private,
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
                conversationId: conversationManager.activeConversationId,
                anchorMessageId: $conversationManager.pendingAnchorMessageId,
                highlightedMessageId: $conversationManager.highlightedMessageId
            )
        }
    }

    @ViewBuilder
    func fullWindowPanel(_ panel: SidePanelType) -> some View {
        switch panel {
        case .settings:
            SettingsPanel(onClose: { windowState.navigateBackOrDismiss() }, store: settingsStore, connectionManager: connectionManager, conversationManager: conversationManager, authManager: authManager, assistantFeatureFlagStore: assistantFeatureFlagStore, showToast: { msg, style in windowState.showToast(message: msg, style: style) }, onEnableIntegration: {
                    conversationManager.openConversation(
                        message: "I'd like to enable an oauth integration. What integrations are available for me to connect to?",
                        forceNew: true
                    )
                    withAnimation(VAnimation.panel) {
                        if let id = conversationManager.activeConversationId {
                            windowState.selection = .conversation(id)
                        } else {
                            windowState.selection = nil
                        }
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
                        withAnimation(VAnimation.panel) {
                            windowState.selection = .conversation(id)
                        }
                    }
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
                assistantFeatureFlagStore: assistantFeatureFlagStore,
                showToast: { msg, style in windowState.showToast(message: msg, style: style) },
                initialTab: windowState.pendingMemoryId != nil ? "Memories" : windowState.pendingSkillId != nil ? "Skills" : nil,
                pendingMemoryId: $windowState.pendingMemoryId,
                pendingSkillId: $windowState.pendingSkillId
            )
        case .home:
            homePanelView(onDismiss: { windowState.dismissOverlay() })
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

// MARK: - Wrapper Views

/// Renders the chat interface with an optional message inspector overlay.
/// Owns bootstrap-state reading; ChatView reads viewModel properties directly
/// via @Bindable. Inspector state is shared via `MainWindowState.inspectorMessageId`
/// so both the chat and the subagent panel can trigger it.
struct ActiveChatViewWrapper: View {
    @Bindable var viewModel: ChatViewModel
    var windowState: MainWindowState
    let conversationStartersEnabled: Bool
    let showsConversationHostAccessControl: Bool
    var showThresholdPicker: Bool = false
    var showInspectButton: Bool = false
    var isTTSEnabled: Bool = false
    var ambientAgent: AmbientAgent
    @ObservedObject var settingsStore: SettingsStore
    let conversationManager: ConversationManager
    let onMicrophoneToggle: () -> Void
    var isTemporaryChat: Bool = false
    var isReadonly: Bool = false
    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var conversationId: UUID?
    @Binding var anchorMessageId: UUID?
    @Binding var highlightedMessageId: UUID?

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
                onMicrophoneToggle: onMicrophoneToggle,
                onForkFromMessage: isReadonly ? nil : { [conversationManager] daemonMessageId in
                    Task { @MainActor in
                        await conversationManager.forkConversation(throughDaemonMessageId: daemonMessageId)
                    }
                },
                onInspectMessage: { presentInspector(for: $0) },
                onSubagentTap: { windowState.selectedSubagentId = $0 },
                onAddFunds: {
                    settingsStore.pendingSettingsTab = .billing
                    withAnimation(VAnimation.panel) {
                        windowState.selection = .panel(.settings)
                    }
                },
                onOpenModelsAndServices: {
                    settingsStore.pendingSettingsTab = .modelsAndServices
                    withAnimation(VAnimation.panel) {
                        windowState.selection = .panel(.settings)
                    }
                },
                onBootstrapSendLogs: {
                    AppDelegate.shared?.showLogReportWindow(reason: .bugReport)
                },
                recoveryMode: settingsStore.managedAssistantRecoveryMode,
                isRecoveryModeExiting: settingsStore.recoveryModeExiting,
                onResumeAssistant: {
                    settingsStore.exitManagedAssistantRecoveryMode()
                },
                onOpenSSHSettings: {
                    settingsStore.pendingSettingsTab = .developer
                    withAnimation(VAnimation.panel) {
                        windowState.selection = .panel(.settings)
                    }
                },
                anchorMessageId: $anchorMessageId,
                highlightedMessageId: $highlightedMessageId,
                conversationId: conversationId,
                isInteractionEnabled: windowState.inspectorMessageId == nil,
                isReadonly: isReadonly,
                isBootstrapping: isBootstrapping,
                isBootstrapTimedOut: isBootstrapTimedOut,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                isTemporaryChat: isTemporaryChat,
                conversationStartersEnabled: conversationStartersEnabled,
                voiceModeManager: voiceModeManager,
                voiceService: voiceService,
                onEndVoiceMode: onEndVoiceMode,
                onDictateToggle: onDictateToggle,
                onVoiceModeToggle: onVoiceModeToggle,
                watchSession: ambientAgent.activeWatchSession,
                conversationManager: conversationManager,
                showsConversationHostAccessControl: showsConversationHostAccessControl,
                showThresholdPicker: showThresholdPicker
            )
            .environment(\.cmdEnterToSend, settingsStore.cmdEnterToSend)
            .disabled(windowState.inspectorMessageId != nil)

            if let messageId = windowState.inspectorMessageId {
                MessageInspectorView(
                    messageId: messageId,
                    onBack: dismissInspector
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
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
