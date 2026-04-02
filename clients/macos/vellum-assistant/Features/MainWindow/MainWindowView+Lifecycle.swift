import Combine
import SwiftUI
import VellumAssistantShared

// MARK: - Lifecycle & Notification Handlers

extension MainWindowView {

    func applyLifecycleModifiers<Content: View>(to content: Content) -> some View {
        content
            .onAppear { handleCoreLayoutAppear() }
            .onDisappear { handleCoreLayoutDisappear() }
            .onReceive(NotificationCenter.default.publisher(for: .identityFileDidChange)) { _ in
                Task {
                    let info = await IdentityInfo.refreshCache()
                    cachedAssistantName = AssistantDisplayName.resolve(info?.name, fallback: "Your Assistant")
                    if info != nil { assistantNameResolved = true }
                }
            }
            .onReceive(connectionManager.$isConnected) { connected in
                handleDaemonConnectionChange(connected)
            }
            .onReceive(connectionManager.$lastUpdateOutcome) { outcome in
                guard let outcome else { return }
                handleUpdateOutcome(outcome)
                connectionManager.clearLastUpdateOutcome()
            }
            .onChange(of: conversationManager.conversations.isEmpty) { _, isEmpty in
                if !isEmpty && showDaemonLoading {
                    withAnimation(VAnimation.standard) {
                        showDaemonLoading = false
                    }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                conversationManager.markActiveConversationSeenIfNeeded()
            }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.willEnterFullScreenNotification)) { notification in
                guard notification.object is TitleBarZoomableWindow else { return }
                isInFullscreen = true
            }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.willExitFullScreenNotification)) { notification in
                guard notification.object is TitleBarZoomableWindow else { return }
                isInFullscreen = false
            }
    }

    func applyConversationSelectionModifiers<Content: View>(to content: Content) -> some View {
        content
            .onChange(of: selectedConversationId) { _, newId in
                if let newId {
                    conversationManager.selectConversation(id: newId)
                }
            }
            .onChange(of: conversationManager.activeConversationId) { oldId, newId in
                handleActiveConversationIdChange(oldId: oldId, newId: newId)
            }
    }

    func applyWorkspaceNotificationModifiers<Content: View>(to content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: .openDynamicWorkspace)) { notification in
                handleOpenDynamicWorkspace(notification)
            }
            .onReceive(NotificationCenter.default.publisher(for: .shareAppCloud)) { notification in
                guard let appId = notification.userInfo?["appId"] as? String else { return }
                bundleAndShare(appId: appId)
            }
            .onReceive(NotificationCenter.default.publisher(for: .pinApp)) { notification in
                handlePinAppNotification(notification, isPinned: true)
            }
            .onReceive(NotificationCenter.default.publisher(for: .unpinApp)) { notification in
                handlePinAppNotification(notification, isPinned: false)
            }
            .onReceive(NotificationCenter.default.publisher(for: .queryAppPinState)) { notification in
                handleQueryAppPinState(notification)
            }
            .onReceive(NotificationCenter.default.publisher(for: .openDocumentEditor)) { notification in
                handleOpenDocumentEditor(notification)
            }
            .onReceive(NotificationCenter.default.publisher(for: .updateDynamicWorkspace)) { notification in
                if let updated = notification.userInfo?["surface"] as? Surface,
                   updated.id == windowState.activeDynamicSurface?.surfaceId {
                    windowState.activeDynamicParsedSurface = updated
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .requestAppPreview)) { notification in
                handleRequestAppPreview(notification)
            }
            .onReceive(NotificationCenter.default.publisher(for: .dismissDynamicWorkspace)) { notification in
                handleDismissDynamicWorkspace(notification)
            }
    }

    // MARK: - Event Handlers

    func handleCoreLayoutAppear() {
        // Sync fullscreen state for windows restored into fullscreen by macOS state restoration.
        if let window = NSApp.windows.first(where: { $0 is TitleBarZoomableWindow }) {
            isInFullscreen = window.styleMask.contains(.fullScreen)
        }
        // Reset stale chat-dock state for users upgrading from older versions.
        // Without this, isAppChatOpen could remain persisted as true with
        // no UI to disable it, leaving panels stuck in split mode.
        isAppChatOpen = false
        Task {
            let info = await IdentityInfo.loadAsync()
            cachedAssistantName = AssistantDisplayName.resolve(info?.name, fallback: "Your Assistant")
            if info != nil { assistantNameResolved = true }
        }
        startIdentityFileWatcher()
        selectedConversationId = conversationManager.activeConversationId
        if let activeId = conversationManager.activeConversationId {
            windowState.persistentConversationId = activeId
        }
        eventStreamClient.startSSE()

        // Show toast for update outcomes emitted while the main window was not visible.
        // The onReceive handler for lastUpdateOutcome covers outcomes arriving while
        // the view is live; this catches any that were missed in between.
        if let outcome = connectionManager.lastUpdateOutcome {
            handleUpdateOutcome(outcome)
            connectionManager.clearLastUpdateOutcome()
        }
    }

    /// Restarts the current assistant's daemon by sleeping then waking it.
    func rewakeAssistant() {
        Task {
            guard let appDelegate = AppDelegate.shared,
                  let assistantName = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return }
            try? await appDelegate.vellumCli.sleep(name: assistantName)
            try? await appDelegate.vellumCli.wake(name: assistantName)
        }
    }

    func handleCoreLayoutDisappear() {
        sharing.errorDismissTask?.cancel()
        sharing.errorDismissTask = nil
        sharing.credentialPollTimer?.invalidate()
        sharing.credentialPollTimer = nil
        sharing.pendingPublish = nil
        identityFileWatcher?.cancel()
        identityFileWatcher = nil
        eventStreamClient.stopSSE()
    }

    /// Watch ~/.vellum/workspace/IDENTITY.md for writes and refresh the
    /// cached assistant display name when the file changes on disk.
    func startIdentityFileWatcher() {
        identityFileWatcher?.cancel()
        identityFileWatcher = nil

        let identityPath = NSHomeDirectory() + "/.vellum/workspace/IDENTITY.md"
        let fd = open(identityPath, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename],
            queue: .global(qos: .utility)
        )
        // Post a notification so the SwiftUI view can pick up the change
        // without capturing `self` (which is a struct).
        source.setEventHandler {
            NotificationCenter.default.post(name: .identityFileDidChange, object: nil)
        }
        source.setCancelHandler {
            close(fd)
        }
        source.resume()
        identityFileWatcher = source
    }

    func handleDaemonConnectionChange(_ connected: Bool) {
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

    func handleUpdateOutcome(_ outcome: UpdateOutcome) {
        switch outcome.result {
        case .succeeded(let version):
            AppDelegate.shared?.updateManager.clearServiceGroupFlags()
            windowState.showToast(
                message: "Assistant updated to \(version)",
                style: .success,
                autoDismissDelay: 8
            )
        case .rolledBack(_, let to):
            let verb: String = {
                let assistants = LockfileAssistant.loadAll()
                let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
                if let id = connectedId,
                   let assistant = assistants.first(where: { $0.assistantId == id }),
                   assistant.isManaged {
                    return "downgraded"
                }
                return "rolled back"
            }()
            windowState.showToast(
                message: "Update failed — \(verb) to \(to)",
                style: .warning,
                autoDismissDelay: 10
            )
        case .timedOut:
            windowState.showToast(
                message: "Update may not have completed. Check Settings for current version.",
                style: .warning,
                primaryAction: VToastAction(label: "Open Settings") {
                    settingsStore.pendingSettingsTab = .general
                    windowState.selection = .panel(.settings)
                },
                autoDismissDelay: 15
            )
        case .failed:
            windowState.showToast(
                message: "Update failed. Try again from Settings.",
                style: .error,
                primaryAction: VToastAction(label: "Open Settings") {
                    settingsStore.pendingSettingsTab = .general
                    windowState.selection = .panel(.settings)
                },
                autoDismissDelay: 15
            )
        }
    }

    func handleActiveConversationIdChange(oldId: UUID?, newId: UUID?) {
        // Sync activeConversationId changes back to selectedConversationId to keep sidebar selection in sync
        selectedConversationId = newId
        // Always sync persistentConversationId so the sidebar highlights the
        // correct conversation — even when an overlay (.panel, .app) is active.
        // Without this, archiving the active conversation while viewing a panel
        // leaves persistentConversationId pointing at the archived (invisible) conversation
        // and the sidebar shows no active highlight.
        // Clear it when entering draft mode (nil) so no conversation appears active.
        windowState.persistentConversationId = newId
        switch windowState.selection {
        case .panel(.intelligence), .panel(.documentEditor):
            windowState.selection = nil
        default:
            break
        }
        windowState.selectedSubagentId = nil
        if let oldId {
            conversationManager.clearActiveSurface(conversationId: oldId)
        }
        conversationManager.activeViewModel?.activeSurfaceId = windowState.isDynamicExpanded ? windowState.activeDynamicSurface?.surfaceId : nil
        conversationManager.activeViewModel?.isChatDockedToSide = windowState.isDynamicExpanded && windowState.isChatDockOpen
        conversationManager.activeViewModel?.consumeDeepLinkIfNeeded()
    }

    func handleOpenDynamicWorkspace(_ notification: Notification) {
        if let msg = notification.userInfo?["surfaceMessage"] as? UiSurfaceShowMessage {
            // Full message from daemon live event (AppDelegate path)
            windowState.activeDynamicSurface = msg
            windowState.activeDynamicParsedSurface = Surface.from(msg)
            if let surface = windowState.activeDynamicParsedSurface,
               case .dynamicPage(let dpData) = surface.data,
               let appId = dpData.appId {
                windowState.selection = .app(appId)
            } else {
                windowState.selection = .app(msg.surfaceId)
            }
        } else if let ref = notification.userInfo?["surfaceRef"] as? SurfaceRef {
            if let appId = ref.appId {
                // Persistent app — re-open via the apps endpoint.
                windowState.selection = .app(appId)
                Task { await AppsClient.openAppAndDispatchSurface(id: appId, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
            } else {
                // Ephemeral surface (ui_show) — fetch from daemon or client memory.
                windowState.selection = .app(ref.surfaceId)
                Task { await reopenEphemeralSurface(ref) }
            }
        }
    }

    /// Fetch surface content for an ephemeral (non-app) dynamic page surface
    /// and set it as the active workspace surface. Tries the daemon's surface
    /// content endpoint first, falls back to the conversation message list.
    func reopenEphemeralSurface(_ ref: SurfaceRef) async {
        // Primary: fetch from daemon in-memory surface state.
        if let conversationId = ref.conversationId {
            if let content = await SurfaceClient().fetchSurfaceContent(surfaceId: ref.surfaceId, conversationId: conversationId) {
                let msg = UiSurfaceShowMessage(
                    conversationId: conversationId,
                    surfaceId: ref.surfaceId,
                    surfaceType: content.surfaceType,
                    title: content.title ?? ref.title,
                    data: AnyCodable(content.rawData),
                    actions: nil,
                    display: "panel",
                    messageId: nil
                )
                windowState.activeDynamicSurface = msg
                windowState.activeDynamicParsedSurface = Surface.from(msg)
                return
            }
        }

        // Fallback: reconstruct from inline surface data in the conversation.
        if let inlineData = conversationManager.activeViewModel?.messages
            .lazy.flatMap({ $0.inlineSurfaces })
            .first(where: { $0.id == ref.surfaceId }),
           case .dynamicPage(let dpData) = inlineData.data {
            let msg = UiSurfaceShowMessage(
                conversationId: ref.conversationId,
                surfaceId: ref.surfaceId,
                surfaceType: ref.surfaceType,
                title: ref.title ?? inlineData.title,
                data: AnyCodable(dpData.asDictionary),
                actions: nil,
                display: "panel",
                messageId: nil
            )
            windowState.activeDynamicSurface = msg
            windowState.activeDynamicParsedSurface = Surface.from(msg)
            return
        }

        // Both paths failed — clear loading state so user isn't stuck.
        windowState.closeDynamicPanel()
        windowState.showToast(message: "Failed to load surface", style: .error)
    }

    func handlePinAppNotification(_ notification: Notification, isPinned: Bool) {
        guard let appId = notification.userInfo?["appId"] as? String else { return }
        if isPinned {
            appListManager.pinApp(id: appId)
        } else {
            appListManager.unpinApp(id: appId)
        }
        NotificationCenter.default.post(
            name: Notification.Name("MainWindow.appPinStateChanged"),
            object: nil,
            userInfo: ["appId": appId, "isPinned": isPinned]
        )
    }

    func handleQueryAppPinState(_ notification: Notification) {
        guard let appId = notification.userInfo?["appId"] as? String else { return }
        let pinned = appListManager.apps.first(where: { $0.id == appId })?.isPinned ?? false
        NotificationCenter.default.post(
            name: Notification.Name("MainWindow.appPinStateChanged"),
            object: nil,
            userInfo: ["appId": appId, "isPinned": pinned]
        )
    }

    func handleOpenDocumentEditor(_ notification: Notification) {
        guard let surfaceId = notification.userInfo?["documentSurfaceId"] as? String else { return }
        if documentManager.hasActiveDocument && documentManager.surfaceId == surfaceId {
            windowState.selection = .panel(.documentEditor)
            return
        }

        Task {
            guard let response = await DocumentClient().fetchDocument(surfaceId: surfaceId) else { return }
            guard response.success else {
                windowState.showToast(
                    message: "Failed to load document\(response.error.map { ": \($0)" } ?? "")",
                    style: .error
                )
                return
            }
            documentManager.createDocument(
                surfaceId: response.surfaceId,
                conversationId: response.conversationId,
                title: response.title,
                initialContent: response.content
            )
            windowState.selection = .panel(.documentEditor)
        }
    }

    func handleRequestAppPreview(_ notification: Notification) {
        guard let appId = notification.userInfo?["appId"] as? String else { return }
        let html = notification.userInfo?["html"] as? String
        Task { @MainActor in
            let response = await AppsClient().fetchAppPreview(appId: appId)
            if let base64 = response?.preview, !base64.isEmpty {
                NotificationCenter.default.post(
                    name: .appPreviewImageCaptured,
                    object: nil,
                    userInfo: ["appId": appId, "previewImage": base64]
                )
            } else if let html,
                      let base64 = await OffscreenPreviewCapture.capture(html: html) {
                _ = await AppsClient().updateAppPreview(appId: appId, preview: base64)
                NotificationCenter.default.post(
                    name: .appPreviewImageCaptured,
                    object: nil,
                    userInfo: ["appId": appId, "previewImage": base64]
                )
            }
        }
    }

    func handleDismissDynamicWorkspace(_ notification: Notification) {
        if let surfaceId = notification.userInfo?["surfaceId"] as? String {
            if windowState.activeDynamicSurface?.surfaceId == surfaceId {
                sharing.showSharePicker = false
                windowState.closeDynamicPanel()
            }
            return
        }

        if case .app = windowState.selection {
            sharing.showSharePicker = false
            windowState.closeDynamicPanel()
        } else if case .appEditing = windowState.selection {
            sharing.showSharePicker = false
            windowState.closeDynamicPanel()
        }
    }
}
