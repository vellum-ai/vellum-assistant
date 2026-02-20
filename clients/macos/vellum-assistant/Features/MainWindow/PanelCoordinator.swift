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
            IdentityPanel(onClose: { windowState.selection = nil }, onCustomizeAvatar: { windowState.selection = .panel(.avatarCustomization) }, daemonClient: daemonClient)
        case .avatarCustomization:
            AvatarCustomizationPanel(onClose: { windowState.selection = .panel(.identity) })
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
                        if let threadId = threadManager.activeThreadId {
                            windowState.setAppEditing(appId: appId, threadId: threadId)
                        }
                    }
                    // Route relay_prompt actions directly as chat messages so they
                    // reach the active session instead of being lost when the surface
                    // was opened outside a session context (e.g. home base via app_open).
                    if actionId == "relay_prompt" || actionId == "agent_prompt",
                       let dataDict = actionData as? [String: Any],
                       let prompt = dataDict["prompt"] as? String,
                       !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        // Ensure a thread exists so the prompt doesn't silently fail
                        // on fresh app launch before any chat thread is created.
                        if threadManager.activeViewModel == nil {
                            threadManager.createThread()
                        }
                        if let vm = threadManager.activeViewModel {
                            // Sync dock state before sending so the message is
                            // classified correctly (chat vs. workspace refinement).
                            vm.isChatDockedToSide = windowState.isChatDockOpen
                            vm.inputText = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                            vm.sendMessage()
                        }
                        return
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
    func chatContentView(geometry: GeometryProxy) -> some View {
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
                // Compute content area width (sidebar is an overlay, doesn't reduce content width)
                let contentWidth = Double(geometry.size.width) / zoomManager.zoomLevel - Double(VSpacing.sm)
                let effectiveWidth = Binding<Double>(
                    get: { appPanelWidth > 0 ? appPanelWidth : contentWidth * 0.7 },
                    set: { appPanelWidth = $0 }
                )
                VSplitView(
                    panelWidth: effectiveWidth,
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
                // Full-window panels: settings, debug, doctor, identity
                fullWindowPanel(panelType)
            }
        case nil:
            // Default: show chat for active thread
            defaultChatLayout
        }
    }

    /// The default chat layout used when showing a thread or no specific selection.
    @ViewBuilder
    var defaultChatLayout: some View {
        let config = windowState.layoutConfig
        let showConfigPanel = config.right.visible && config.right.content != .empty
        let showSubagentPanel = windowState.selectedSubagentId != nil && threadManager.activeViewModel != nil

        VSplitView(
            panelWidth: $sidePanelWidth,
            showPanel: showConfigPanel || showSubagentPanel,
            main: { slotView(for: config.center.content) },
            panel: {
                if let subagentId = windowState.selectedSubagentId,
                   let viewModel = threadManager.activeViewModel {
                    SubagentDetailPanel(
                        subagentId: subagentId,
                        viewModel: viewModel,
                        detailStore: viewModel.subagentDetailStore,
                        onAbort: { try? daemonClient.sendSubagentAbort(subagentId: subagentId) },
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
    func fullWindowPanel(_ panel: SidePanelType) -> some View {
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
            IdentityPanel(onClose: { windowState.dismissOverlay() }, onCustomizeAvatar: { windowState.selection = .panel(.avatarCustomization) }, daemonClient: daemonClient)
                .overlay(alignment: .topTrailing) { panelDismissButton }
        case .avatarCustomization:
            AvatarCustomizationPanel(onClose: { windowState.selection = .panel(.identity) })
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
    func panelDismissAction() {
        // Avatar customization → back to Identity; everything else → dismiss overlay
        if case .panel(.avatarCustomization) = windowState.selection {
            windowState.selection = .panel(.identity)
        } else {
            windowState.dismissOverlay()
        }
    }

    var panelDismissButton: some View {
        Button(action: panelDismissAction) {
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
    func dynamicWorkspaceView(surface: Surface, data: DynamicPageSurfaceData) -> some View {
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
struct ActiveChatViewWrapper: View {
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
            onSend: {
                if viewModel.isRecording { onMicrophoneToggle() }
                viewModel.sendMessage()
            },
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
            onAlwaysAllow: { requestId, selectedPattern, selectedScope, decision in viewModel.respondToAlwaysAllow(requestId: requestId, selectedPattern: selectedPattern, selectedScope: selectedScope, decision: decision) },
            onSurfaceAction: { surfaceId, actionId, data in viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data) },
            onRegenerate: { viewModel.regenerateLastMessage() },
            sessionError: viewModel.sessionError,
            onRetry: { viewModel.retryAfterSessionError() },
            onDismissSessionError: { viewModel.dismissSessionError() },
            onCopyDebugInfo: { viewModel.copySessionErrorDebugDetails() },
            watchSession: ambientAgent.activeWatchSession,
            onStopWatch: { viewModel.stopWatchSession() },
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
            onDeleteQueuedMessage: { messageId in viewModel.deleteQueuedMessage(messageId: messageId) },
            onSendDirectQueuedMessage: { messageId in viewModel.sendDirectQueuedMessage(messageId: messageId) },
            mediaEmbedSettings: MediaEmbedResolverSettings(
                enabled: settingsStore.mediaEmbedsEnabled,
                enabledSince: settingsStore.mediaEmbedsEnabledSince,
                allowedDomains: settingsStore.mediaEmbedVideoAllowlistDomains
            ),
            isTemporaryChat: isTemporaryChat,
            activeSubagents: viewModel.activeSubagents,
            onAbortSubagent: { subagentId in
                try? daemonClient.sendSubagentAbort(subagentId: subagentId)
            },
            onSubagentTap: { subagentId in
                windowState.selectedSubagentId = subagentId
            },
            daemonHttpPort: daemonClient.httpPort,
            dismissedDocumentSurfaceIds: viewModel.dismissedDocumentSurfaceIds,
            onDismissDocumentWidget: { viewModel.dismissDocumentSurface(id: $0) }
        )
    }
}

// MARK: - Ghost Button

/// A borderless button with a rounded-rectangle outline, monospace font, and subtle hover fill.
struct GhostButton: View {
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
struct DynamicWorkspaceWrapper: View {
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
                    // Route relay_prompt actions directly as chat messages so they
                    // reach the active session instead of being lost when the surface
                    // was opened outside a session context (e.g. home base via app_open).
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
                .padding(.leading, isChatDockOpen ? VSpacing.lg : trafficLightPadding)
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
