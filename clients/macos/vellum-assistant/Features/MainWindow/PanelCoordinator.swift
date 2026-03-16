import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

// MARK: - Panel Coordination Extension

extension MainWindowView {

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
            SettingsPanel(onClose: { windowState.selection = nil }, store: settingsStore, daemonClient: daemonClient, conversationManager: conversationManager, authManager: authManager)
        case .debug:
            DebugPanel(
                traceStore: traceStore,
                daemonClient: daemonClient,
                activeSessionId: conversationManager.activeViewModel?.conversationId,
                onClose: { windowState.selection = nil }
            )
        case .generated:
            GeneratedPanel(
                onClose: { sharing.showSharePicker = false; windowState.closeDynamicPanel() },
                isExpanded: Binding(
                    get: { windowState.isDynamicExpanded },
                    set: { windowState.isDynamicExpanded = $0 }
                ),
                daemonClient: daemonClient,
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
                daemonClient: daemonClient,
                gatewayBaseURL: settingsStore.localGatewayTarget,
                onOpenApp: { appId in
                    try? daemonClient.sendAppOpen(appId: appId)
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
                onClose: { windowState.selection = nil },
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
                daemonClient: daemonClient,
                initialTab: windowState.pendingMemoryId != nil ? "Memories" : nil,
                pendingMemoryId: $windowState.pendingMemoryId
            )
        case .usageDashboard:
            UsageDashboardPanel(
                store: usageDashboardStore,
                onClose: { windowState.selection = nil }
            )
        }
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
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
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
    func clampedPanelWidth(geometry: GeometryProxy) -> Binding<Double> {
        // Sidebar sits in the HStack and consumes real width.
        // When settings is open the sidebar is hidden.
        let settingsOpen: Bool = {
            if case .panel(.settings) = windowState.selection { return true }
            return false
        }()
        let sidebarWidth: CGFloat = settingsOpen ? 0 : (sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth)
        let hstackSpacing: CGFloat = 16
        let outerPadding: CGFloat = 32 // 16 left + 16 right
        let windowWidth: Double = Double(geometry.size.width) / zoomManager.zoomLevel
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

    func clampedChatDockWidth(geometry: GeometryProxy) -> Binding<Double> {
        let settingsOpen: Bool = {
            if case .panel(.settings) = windowState.selection { return true }
            return false
        }()
        let sidebarWidth: CGFloat = settingsOpen ? 0 : (sidebarExpanded ? sidebarExpandedWidth : sidebarCollapsedWidth)
        let hstackSpacing: CGFloat = 16
        let outerPadding: CGFloat = 32
        let windowWidth: Double = Double(geometry.size.width) / zoomManager.zoomLevel
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
    func chatContentView(geometry: GeometryProxy) -> some View {
        switch windowState.selection {
        case .conversation:
            // Show chat for this conversation (conversationManager.activeViewModel is synced)
            defaultChatLayout
        case .app(let appId), .appEditing(let appId, _):
            if let surface = windowState.activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data {
                AppWorkspaceDockLayout(
                    dockWidth: clampedChatDockWidth(geometry: geometry),
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
                        try? daemonClient.sendAppOpen(appId: appId)
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
                    daemonClient: daemonClient,
                    gatewayBaseURL: settingsStore.localGatewayTarget,
                    onOpenApp: { appId in
                        try? daemonClient.sendAppOpen(appId: appId)
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
                .overlay(alignment: .topTrailing) { panelDismissButton }
                .background(VColor.surfaceBase)
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
                .onAppear {
                    conversationManager.ensureActiveConversation(preferredConversationId: documentManager.conversationId)
                }
            } else if isAppChatOpen {
                // Split view: chat (left) + panel (right)
                VSplitView(
                    panelWidth: clampedPanelWidth(geometry: geometry),
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
                // Full-window panels: settings, debug, identity
                fullWindowPanel(panelType)
            }
        case nil:
            // Default: show chat for active conversation
            defaultChatLayout
        }
    }

    /// The default chat layout used when showing a conversation or no specific selection.
    @ViewBuilder
    var defaultChatLayout: some View {
        let config = windowState.layoutConfig
        let showConfigPanel = config.right.visible && config.right.content != .empty
        let showSubagentPanel = windowState.selectedSubagentId != nil && conversationManager.activeViewModel != nil

        VSplitView(
            panelWidth: $sidePanelWidth,
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
                        onAbort: { try? daemonClient.sendSubagentAbort(subagentId: subagentId, conversationId: viewModel.conversationId) },
                        onRequestDetail: {
                            if let conversationId = viewModel.activeSubagents.first(where: { $0.id == subagentId })?.conversationId {
                                try? daemonClient.sendSubagentDetailRequest(subagentId: subagentId, conversationId: conversationId)
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
            ActiveChatViewWrapper(
                viewModel: viewModel,
                windowState: windowState,
                daemonClient: daemonClient,
                ambientAgent: ambientAgent,
                settingsStore: settingsStore,
                onMicrophoneToggle: onMicrophoneToggle,
                isTemporaryChat: activeConversation?.kind == .private,
                voiceModeManager: voiceModeManager,
                voiceService: voiceModeManager.openAIVoiceService,
                onEndVoiceMode: {
                    voiceModeManager.deactivate()
                },
                onDictateToggle: {
                    AppDelegate.shared?.voiceInput?.toggleRecording(origin: .chatComposer)
                },
                onVoiceModeToggle: {
                    toggleVoiceMode()
                },
                conversationId: conversationManager.activeConversationId,
                anchorMessageId: $conversationManager.pendingAnchorMessageId,
                highlightedMessageId: $conversationManager.highlightedMessageId
            )
            .environment(\.conversationZoomScale, conversationZoomManager.zoomLevel)
            .overlay(alignment: .top) {
                if conversationZoomManager.showZoomIndicator {
                    ZoomIndicatorView(percentage: conversationZoomManager.zoomPercentage, label: "Text")
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .padding(.top, VSpacing.xl)
                }
            }
            .animation(VAnimation.fast, value: conversationZoomManager.showZoomIndicator)
        }
    }

    @ViewBuilder
    func fullWindowPanel(_ panel: SidePanelType) -> some View {
        switch panel {
        case .settings:
            SettingsPanel(onClose: { windowState.dismissOverlay() }, store: settingsStore, daemonClient: daemonClient, conversationManager: conversationManager, authManager: authManager)
        case .debug:
            DebugPanel(
                traceStore: traceStore,
                daemonClient: daemonClient,
                activeSessionId: conversationManager.activeViewModel?.conversationId,
                onClose: { windowState.dismissOverlay() }
            )
            .overlay(alignment: .topTrailing) { panelDismissButton }
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
                daemonClient: daemonClient,
                gatewayBaseURL: settingsStore.localGatewayTarget,
                onOpenApp: { appId in
                    try? daemonClient.sendAppOpen(appId: appId)
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
            .overlay(alignment: .topTrailing) { panelDismissButton }
            .background(VColor.surfaceBase)
        case .intelligence:
            IntelligencePanel(
                onClose: { windowState.dismissOverlay() },
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
                daemonClient: daemonClient,
                initialTab: windowState.pendingMemoryId != nil ? "Memories" : nil,
                pendingMemoryId: $windowState.pendingMemoryId
            )
            .overlay(alignment: .topTrailing) { panelDismissButton }
            .background(VColor.surfaceOverlay)
        case .usageDashboard:
            UsageDashboardPanel(
                store: usageDashboardStore,
                onClose: { windowState.dismissOverlay() }
            )
            .overlay(alignment: .topTrailing) { panelDismissButton }
        }
    }

    /// Consistent X close button for panel overlays.
    func panelDismissAction() {
        // Avatar customization → back to originating panel; everything else → dismiss overlay
        if case .panel(.avatarCustomization) = windowState.selection {
            windowState.selection = .panel(windowState.avatarCustomizationReturnPanel)
        } else {
            windowState.dismissOverlay()
        }
    }

    var panelDismissButton: some View {
        VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost, action: panelDismissAction)
            .padding(.top, VSpacing.lg)
            .padding(.trailing, VSpacing.lg)
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
                daemonClient: daemonClient,
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

// MARK: - File Picker Helper

@MainActor
func openFilePicker(viewModel: ChatViewModel) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    panel.allowedContentTypes = [
        .png, .jpeg, .gif, .webP, .pdf, .plainText, .commaSeparatedText,
        UTType("net.daringfireball.markdown") ?? .plainText,
        .movie, .mpeg4Movie, .quickTimeMovie, .avi,
        .mp3, .wav, .aiff, .audio,
    ]
    // Present as a window sheet instead of a blocking app-modal dialog
    // so the user can still see the chat while picking files.
    guard let window = NSApp.keyWindow ?? NSApp.mainWindow else {
        // Fallback to modal if no window is available.
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            viewModel.addAttachment(url: url)
        }
        return
    }
    panel.beginSheetModal(for: window) { response in
        guard response == .OK else { return }
        for url in panel.urls {
            viewModel.addAttachment(url: url)
        }
    }
}

// MARK: - Wrapper Views
// These observe the ChatViewModel directly so that only the views that
// actually need ChatViewModel state are invalidated on change, instead
// of propagating every change up through ConversationManager.

/// Observes the active ChatViewModel and renders the chat interface.
struct ActiveChatViewWrapper: View {
    @ObservedObject var viewModel: ChatViewModel
    @ObservedObject var windowState: MainWindowState
    let daemonClient: DaemonClient
    @ObservedObject var ambientAgent: AmbientAgent
    @ObservedObject var settingsStore: SettingsStore
    let onMicrophoneToggle: () -> Void
    var isTemporaryChat: Bool = false
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
        ChatView(
            messages: viewModel.messages,
            inputText: Binding(
                get: { viewModel.inputText },
                set: { viewModel.inputText = $0 }
            ),
            hasAPIKey: windowState.hasAPIKey,
            isThinking: viewModel.isThinking,
            isCompacting: viewModel.isCompacting,
            isSending: viewModel.isSending,
            suggestion: viewModel.suggestion,
            pendingAttachments: viewModel.pendingAttachments,
            isLoadingAttachment: viewModel.isLoadingAttachment,
            isRecording: viewModel.isRecording,
            onSend: {
                if viewModel.isRecording { onMicrophoneToggle() }
                viewModel.sendMessage()
            },
            onStop: viewModel.stopGenerating,
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
            assistantActivityPhase: viewModel.assistantActivityPhase,
            assistantActivityAnchor: viewModel.assistantActivityAnchor,
            assistantActivityReason: viewModel.assistantActivityReason,
            assistantStatusText: viewModel.assistantStatusText,
            onConfirmationAllow: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "allow") },
            onConfirmationDeny: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "deny") },
            onAlwaysAllow: { requestId, selectedPattern, selectedScope, decision in viewModel.respondToAlwaysAllow(requestId: requestId, selectedPattern: selectedPattern, selectedScope: selectedScope, decision: decision) },
            onTemporaryAllow: { requestId, decision in viewModel.respondToConfirmation(requestId: requestId, decision: decision) },
            onGuardianAction: { requestId, action in viewModel.submitGuardianDecision(requestId: requestId, action: action) },
            onSurfaceAction: { surfaceId, actionId, data in viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data) },
            watchSession: ambientAgent.activeWatchSession,
            onStopWatch: { viewModel.stopWatchSession() },
            onReportMessage: { daemonMessageId in
                guard let conversationId = viewModel.conversationId else { return }
                do {
                    try daemonClient.sendDiagnosticsExportRequest(
                        conversationId: conversationId,
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
            isTemporaryChat: isTemporaryChat,
            activeSubagents: viewModel.activeSubagents,
            onAbortSubagent: { subagentId in
                try? daemonClient.sendSubagentAbort(subagentId: subagentId, conversationId: viewModel.conversationId)
            },
            onSubagentTap: { subagentId in
                windowState.selectedSubagentId = subagentId
            },
            onRehydrateMessage: { messageId in
                viewModel.rehydrateMessage(id: messageId)
            },
            onSurfaceRefetch: { surfaceId, conversationId in
                viewModel.refetchStrippedSurface(surfaceId: surfaceId, conversationId: conversationId)
            },
            onRetryFailedMessage: { messageId in
                viewModel.retryFailedMessage(id: messageId)
            },
            subagentDetailStore: viewModel.subagentDetailStore,
            resolveHttpPort: daemonClient.httpPortResolver,
            isHistoryLoaded: viewModel.isHistoryLoaded,
            dismissedDocumentSurfaceIds: viewModel.dismissedDocumentSurfaceIds,
            onDismissDocumentWidget: { viewModel.dismissDocumentSurface(id: $0) },

            voiceModeManager: voiceModeManager,
            voiceService: voiceService,
            onEndVoiceMode: onEndVoiceMode,
            recordingAmplitude: viewModel.recordingAmplitude,
            onDictateToggle: onDictateToggle,
            onVoiceModeToggle: onVoiceModeToggle,
            conversationId: conversationId,
            daemonGreeting: viewModel.emptyStateGreeting,
            onRequestGreeting: { [weak viewModel] in viewModel?.generateGreeting() },
            anchorMessageId: $anchorMessageId,
            highlightedMessageId: $highlightedMessageId,
            btwResponse: viewModel.btwResponse,
            btwLoading: viewModel.btwLoading,
            onDismissBtw: { viewModel.dismissBtw() },
            creditsExhaustedError: viewModel.errorManager.conversationError?.isCreditsExhausted == true ? viewModel.errorManager.conversationError : nil,
            onAddFunds: {
                settingsStore.pendingSettingsTab = .billing
                windowState.selection = .panel(.settings)
            },
            onDismissCreditsExhausted: { viewModel.dismissConversationError() },
            displayedMessageCount: viewModel.displayedMessageCount,
            hasMoreMessages: viewModel.hasMoreMessages,
            isLoadingMoreMessages: viewModel.isLoadingMoreMessages,
            loadPreviousMessagePage: { await viewModel.loadPreviousMessagePage() },
            isBootstrapping: isBootstrapping,
            isBootstrapTimedOut: isBootstrapTimedOut
        )
        .environment(\.cmdEnterToSend, settingsStore.cmdEnterToSend)
    }
}

/// Observes the active ChatViewModel and renders the dynamic workspace overlays.
struct DynamicWorkspaceWrapper: View {
    @ObservedObject var viewModel: ChatViewModel
    let surface: Surface
    let data: DynamicPageSurfaceData
    @ObservedObject var windowState: MainWindowState
    let surfaceManager: SurfaceManager
    let daemonClient: DaemonClient
    let trafficLightPadding: CGFloat
    let isSidebarOpen: Bool
    var sharing: SharingState
    let gatewayBaseURL: String
    let onPublishPage: (String, String?, String?) -> Void
    let onBundleAndShare: (String) -> Void
    let isChatDockOpen: Bool
    let onToggleChatDock: () -> Void
    let onMicrophoneToggle: () -> Void

    @State private var showVersionHistory = false
    @State private var publishUrlCopied = false
    @State private var showShareDrawer = false
    @State private var shareButtonFrame: CGRect = .zero

    /// Corner radius for the WKWebView clipping container — no rounding needed since the
    /// outer page container handles corner rounding.
    private var webViewCornerRadius: CGFloat { 0 }

    private var webViewMaskedCorners: CACornerMask { [] }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                // Left: Close Chat primary CTA in edit mode, Edit primary button otherwise
                if case .appEditing = windowState.selection {
                    VButton(label: "Close chat", icon: VIcon.x.rawValue, style: .primary) {
                        onToggleChatDock()
                    }
                } else {
                    VButton(label: "Edit", icon: VIcon.pencil.rawValue, style: .primary) {
                        if !isChatDockOpen {
                            windowState.workspaceComposerExpanded = false
                        }
                        onToggleChatDock()
                    }
                    .accessibilityLabel("Edit app")
                }

                Spacer(minLength: 0)

                Text(surface.title ?? data.preview?.title ?? "App")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentSecondary)
                    .lineLimit(1)

                Spacer(minLength: 0)

                // Right: History + Share + Close outlined icon buttons
                HStack(spacing: VSpacing.sm) {
                    if data.appId != nil {
                        VButton(label: "Version history", iconOnly: VIcon.history.rawValue, style: .outlined, iconSize: 32, tooltip: "Version history") {
                            showVersionHistory = true
                        }
                    }

                    if let url = sharing.publishedUrl {
                        PublishedButton(url: url, copied: $publishUrlCopied)
                    }

                    ZStack {
                        if data.appId != nil {
                            if sharing.isBundling || sharing.isPublishing {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(height: 32)
                            } else {
                                VButton(label: "Share", iconOnly: VIcon.share.rawValue, style: .outlined, iconSize: 32, tooltip: "Share") {
                                    showShareDrawer.toggle()
                                }
                                .background(GeometryReader { proxy in
                                    Color.clear.onChange(of: showShareDrawer) { _, _ in
                                        shareButtonFrame = proxy.frame(in: .named("appPageContainer"))
                                    }
                                    .onAppear { shareButtonFrame = proxy.frame(in: .named("appPageContainer")) }
                                })
                                .overlay {
                                    AppSharePanel(
                                        items: sharing.shareFileURL != nil ? [sharing.shareFileURL!] : [],
                                        isPresented: Binding(
                                            get: { sharing.showSharePicker },
                                            set: { sharing.showSharePicker = $0 }
                                        ),
                                        appName: sharing.shareAppName,
                                        appIcon: sharing.shareAppIcon,
                                        appId: sharing.shareAppId,
                                        gatewayBaseURL: gatewayBaseURL
                                    )
                                    .allowsHitTesting(false)
                                }
                            }
                        } else if sharing.isPublishing {
                            ProgressView()
                                .controlSize(.small)
                                .frame(height: 32)
                        } else if sharing.publishedUrl == nil {
                            VButton(label: "Publish", iconOnly: VIcon.arrowUpRight.rawValue, style: .outlined, iconSize: 32, tooltip: "Publish to Vercel") {
                                onPublishPage(data.html, data.preview?.title, data.appId)
                            }
                        }
                    }

                    VButton(label: "Close workspace", iconOnly: VIcon.x.rawValue, style: .outlined, iconSize: 32, tooltip: "Close workspace") {
                        sharing.showSharePicker = false
                        windowState.activeDynamicSurface = nil
                        windowState.activeDynamicParsedSurface = nil
                        windowState.dismissOverlay()
                    }
                }
            }
            .padding(.leading, VSpacing.md)
            .padding(.trailing, VSpacing.md)
            .padding(.vertical, VSpacing.md)
            .background(
                VColor.surfaceOverlay
            )
            .overlay(alignment: .bottom) {
                VColor.borderBase
                    .frame(height: 1)
            }

            if let error = sharing.publishError {
                HStack {
                    Spacer()
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .background(VColor.systemNegativeStrong.opacity(0.8))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .padding(.trailing, VSpacing.xl)
                }
            }

            ZStack {
                if showVersionHistory, let appId = data.appId {
                    AppVersionHistoryPanel(
                        daemonClient: daemonClient,
                        appId: appId,
                        appName: data.preview?.title ?? "App",
                        onClose: { showVersionHistory = false }
                    )
                } else {
                    DynamicPageSurfaceView(
                        data: data,
                        onAction: { actionId, actionData in
                            if !isChatDockOpen {
                                onToggleChatDock()
                            }
                            // Route relay_prompt actions directly as chat messages so they
                            // reach the active session instead of being lost when the surface
                            // was opened outside a session context (e.g. via app_open).
                            if actionId == "relay_prompt" || actionId == "agent_prompt",
                               let dataDict = actionData as? [String: Any],
                               let prompt = dataDict["prompt"] as? String,
                               !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                // Eagerly sync dock state so sendMessage() sees the
                                // up-to-date value instead of the stale pre-toggle state
                                // (onChange(of: windowState.selection) runs asynchronously).
                                viewModel.isChatDockedToSide = true
                                viewModel.inputText = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                                viewModel.sendMessage()
                                return
                            }
                            surfaceManager.onAction?(surface.conversationId, surface.id, actionId, actionData as? [String: Any])
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
                            NotificationCenter.default.post(
                                name: .appPreviewImageCaptured,
                                object: nil,
                                userInfo: ["appId": appId, "previewImage": base64]
                            )
                        } : nil,
                        onLinkOpen: { url, metadata in
                            surfaceManager.onLinkOpen?(url, metadata)
                        },
                        topContentInset: 0,
                        bottomContentInset: 0,
                        cornerRadius: webViewCornerRadius,
                        maskedCorners: webViewMaskedCorners
                    )
                }
            }
        }
        .coordinateSpace(name: "appPageContainer")
        .overlay(alignment: .topLeading) {
            if showShareDrawer {
                // Dismiss backdrop
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { showShareDrawer = false }
            }
        }
        .overlay(alignment: .topLeading) {
            if showShareDrawer, let appId = data.appId {
                ShareDrawer(
                    onShare: {
                        showShareDrawer = false
                        onBundleAndShare(appId)
                    },
                    onPublish: {
                        showShareDrawer = false
                        onPublishPage(data.html, data.preview?.title, data.appId)
                    }
                )
                .offset(
                    x: shareButtonFrame.maxX - 180,
                    y: shareButtonFrame.maxY + VSpacing.xs
                )
                .zIndex(10)
                .transition(.opacity)
            }
        }
    }
}

/// Shows "Published ✓" with an inline copy-to-clipboard button.
/// Tapping the copy icon copies the URL and briefly shows a checkmark.
private struct PublishedButton: View {
    let url: String
    @Binding var copied: Bool

    @State private var isCopyHovered = false
    @State private var resetTimer: DispatchWorkItem?

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.check, size: 10)
                .foregroundColor(VColor.systemPositiveStrong)
            Text("Published")
                .font(VFont.caption)
            Divider()
                .frame(height: 12)
            VIconView(copied ? .check : .copy, size: 10)
                .foregroundColor(copied ? VColor.systemPositiveStrong : (isCopyHovered ? VColor.contentDefault : VColor.primaryBase))
                .animation(VAnimation.fast, value: copied)
                .contentShape(Rectangle())
                .onTapGesture {
                    resetTimer?.cancel()
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                    copied = true
                    let timer = DispatchWorkItem { copied = false }
                    resetTimer = timer
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
                }
                .onHover { hovering in
                    isCopyHovered = hovering
                }
                .pointerCursor()
                .accessibilityLabel(copied ? "URL copied" : "Copy published URL")
        }
        .foregroundColor(VColor.primaryBase)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.buttonV)
        .frame(height: 24)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderActive, lineWidth: 1)
        )
        .controlSize(.small)
    }
}

// MARK: - Share Drawer

/// Popover menu with "Share" and "Publish to Vercel" options.
/// Styled to match ConversationSwitcherDrawer / DrawerMenuView.
private struct ShareDrawer: View {
    let onShare: () -> Void
    let onPublish: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ShareDrawerRow(icon: .share, label: "Share", action: onShare)
            VColor.borderBase.frame(height: 1)
                .padding(.horizontal, VSpacing.xs)
            ShareDrawerRow(icon: .arrowUpRight, label: "Publish to Vercel", action: onPublish)
        }
        .padding(.vertical, VSpacing.xs)
        .frame(width: 180)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .shadow(color: VColor.auxBlack.opacity(0.15), radius: 6, y: 2)
    }
}

private struct ShareDrawerRow: View {
    let icon: VIcon
    let label: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                VIconView(icon, size: 12)
                    .foregroundColor(isHovered ? VColor.contentDefault : VColor.contentSecondary)
                    .frame(width: 18)
                Text(label)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surfaceBase.opacity(isHovered ? 1 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
        .pointerCursor()
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
                    .foregroundColor(VColor.systemNegativeHover)
                Text("Failed to load app")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Text("The app didn't respond in time. It may be unavailable or still starting up.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
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
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
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

