import AppKit
import Combine
import SwiftUI
import UserNotifications
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

// MARK: - Ghost Window Detection

extension NSWindow {
    /// Returns `true` for SwiftUI-managed windows that macOS may restore
    /// during activation-policy transitions (e.g. the Settings scene's
    /// `EmptyView` window). These should be ignored when deciding whether
    /// any real app windows remain visible.
    var isSwiftUIGhostWindow: Bool {
        guard title.contains("Settings") else { return false }
        let contentClassName = contentView.map { NSStringFromClass(type(of: $0)) } ?? ""
        return contentClassName.contains("NSHostingView") || contentView?.subviews.isEmpty == true
    }
}

// MARK: - Activation Policy

extension NSApplication {
    /// Transitions to `.regular` activation policy only when the app is not
    /// already in that mode.  Redundant `setActivationPolicy(.regular)` calls
    /// can cause macOS to re-evaluate the dock tile, which in rare timing
    /// windows produces a duplicate dock entry.
    ///
    /// After transitioning, any stray SwiftUI-managed windows (e.g. the
    /// Settings scene's EmptyView window) are closed.  macOS can restore
    /// these during policy transitions, producing a "ghost" blank window.
    func activateAsDockAppIfNeeded() {
        guard activationPolicy() != .regular else { return }
        setActivationPolicy(.regular)
        dismissSettingsGhostWindows()
    }

    /// Close any SwiftUI Settings-scene windows that macOS may have
    /// restored during an activation-policy transition.  The Settings
    /// scene renders `EmptyView` and should never be user-visible.
    func dismissSettingsGhostWindows() {
        for window in windows where window.isSwiftUIGhostWindow {
            window.orderOut(nil)
        }
    }
}

// MARK: - Surface Wiring

extension AppDelegate {

    func setupSurfaceManager() {
        // Surface event handling is now in startDaemonEventSubscription() via subscribe().

        // Wire SurfaceManager action callback to SurfaceActionClient
        surfaceManager.onAction = { conversationId, surfaceId, actionId, data in
            let codableData: [String: AnyCodable]? = data?.mapValues { AnyCodable($0) }
            Task {
                await SurfaceActionClient().sendSurfaceAction(
                    conversationId: conversationId,
                    surfaceId: surfaceId,
                    actionId: actionId,
                    data: codableData
                )
            }
        }

        // Data request: JS -> Swift -> gateway -> daemon
        surfaceManager.onDataRequest = { [weak self] surfaceId, callId, method, appId, recordId, data in
            guard let self else { return }
            let codableData = data?.mapValues { AnyCodable($0) }
            Task {
                if let response = await self.appsClient.fetchAppData(
                    appId: appId, method: method, recordId: recordId,
                    data: codableData, surfaceId: surfaceId, callId: callId
                ) {
                    self.surfaceManager.resolveDataResponse(surfaceId: surfaceId, response: response)
                } else {
                    log.error("Failed to fetch app data (method: \(method), appId: \(appId))")
                }
            }
        }

        // Link open: JS -> Swift -> gateway
        surfaceManager.onLinkOpen = { url, metadata in
            let codableMetadata = metadata?.mapValues { AnyCodable($0) }
            Task {
                _ = try? await PublishClient().openLink(url: url, metadata: codableMetadata)
            }
        }

        // Route dynamic pages to workspace
        surfaceManager.onDynamicPageShow = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.showMainWindow()
            NotificationCenter.default.post(
                name: .openDynamicWorkspace,
                object: nil,
                userInfo: [
                    "surfaceMessage": msg,
                ]
            )
        }
    }

    func setupToolConfirmationNotifications() {
        // Confirmation handling is now in startDaemonEventSubscription() via subscribe().
    }

    /// Handle a tool confirmation request from the daemon event stream.
    func handleToolConfirmationRequest(_ msg: ConfirmationRequestMessage) {
        Task { @MainActor in
            // Auto-approve low/medium risk tool confirmations during CU sessions
            let cuAutoApprove = self.currentSession?.autoApproveTools == true
                || self.activeHostCuProxy?.autoApproveTools == true
            let cuConversationId = self.activeHostCuProxy?.conversationId
            let confirmationMatchesCuSession = cuConversationId != nil
                && msg.conversationId == cuConversationId
            if cuAutoApprove, confirmationMatchesCuSession,
               (msg.riskLevel == "low" || msg.riskLevel == "medium") {
                let success = await InteractionClient().sendConfirmationResponse(
                    requestId: msg.requestId,
                    decision: "allow"
                )
                if success {
                    self.mainWindow?.conversationManager.updateConfirmationStateAcrossConversations(
                        requestId: msg.requestId,
                        decision: "allow"
                    )
                } else {
                    log.error("Failed to auto-approve confirmation")
                }
                log.info("[confirm-flow] CU auto-approved requestId=\(msg.requestId, privacy: .public) tool=\(msg.toolName, privacy: .public)")
                return
            }

            if NSApp.isActive, let mainWindow = self.mainWindow, mainWindow.isVisible {
                let activeSessionId = mainWindow.conversationManager.activeViewModel?.conversationId
                let confirmationIsForActiveConversation = msg.conversationId == nil || msg.conversationId == activeSessionId
                if confirmationIsForActiveConversation {
                    log.info("[confirm-flow] Skipping notification (app active, inline handles): requestId=\(msg.requestId, privacy: .public) tool=\(msg.toolName, privacy: .public) appActive=\(NSApp.isActive) windowVisible=\(mainWindow.isVisible)")
                    return
                }
            }

            log.info("[confirm-flow] Posting macOS notification: requestId=\(msg.requestId, privacy: .public) tool=\(msg.toolName, privacy: .public)")
            let decision = await self.toolConfirmationNotificationService.showConfirmation(msg)
            log.info("[confirm-flow] Notification path resolved: requestId=\(msg.requestId, privacy: .public) decision=\(decision, privacy: .public) isSentinel=\(decision == ToolConfirmationNotificationService.inlineHandledSentinel)")
            guard decision != ToolConfirmationNotificationService.inlineHandledSentinel else {
                return
            }
            let success = await InteractionClient().sendConfirmationResponse(
                requestId: msg.requestId,
                decision: decision
            )
            if success {
                self.mainWindow?.conversationManager.updateConfirmationStateAcrossConversations(
                    requestId: msg.requestId,
                    decision: decision
                )
            } else {
                log.error("[confirm-flow] Notification-path POST failed: requestId=\(msg.requestId, privacy: .public) decision=\(decision, privacy: .public)")
            }
        }
    }

    func setupSecretPromptManager() {
        // Secret request handling is now in startDaemonEventSubscription() via subscribe().
        secretPromptManager.onResponse = { requestId, value, delivery in
            await InteractionClient().sendSecretResponse(requestId: requestId, value: value, delivery: delivery)
        }
    }
}

// MARK: - Window Observer & Reopen

extension AppDelegate {

    func setupWindowObserver() {
        // Revert to .accessory activation policy when the user closes all
        // windows.  Fires synchronously on NSWindow.willCloseNotification
        // (after the close animation completes) to avoid rapid .accessory →
        // .regular cycling, which can produce duplicate dock tiles on macOS.
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let self else { return }
                guard let closedWindow = notification.object as? NSWindow else { return }

                // Ignore the status-bar button's private window.
                if closedWindow === self.statusItem?.button?.window { return }

                // If the MainWindow is still around (even if it just closed
                // this notification), keep the dock icon visible.
                if self.mainWindow != nil { return }

                self.revertActivationPolicyIfNoWindows(excluding: closedWindow)
            }
        }
    }

    /// Revert to `.accessory` activation policy if no real app windows remain
    /// visible.  Called from the global window-close observer and from
    /// individual window dismiss handlers (e.g. crash report) that may run
    /// before `setupWindowObserver()` is installed.
    ///
    /// Keeps the dock icon visible when a connected assistant exists so the
    /// user can click it to re-open the window. Only reverts after explicit
    /// disconnect (logout, retire, switch assistant).
    func revertActivationPolicyIfNoWindows(excluding closedWindow: NSWindow? = nil) {
        // Keep the dock icon alive while the user has a connected assistant —
        // they can click the dock icon to re-open the main window.
        if UserDefaults.standard.string(forKey: "connectedAssistantId") != nil {
            return
        }

        // Don't revert to .accessory while a computer use session is active —
        // the session overlay needs to remain visible even when the app loses
        // focus to another app (e.g. during wizard flows interacting with
        // browser windows).
        if currentSession?.state.isActiveSession == true
            || activeHostCuProxy?.state.isActiveSession == true {
            return
        }

        let hasVisibleWindows = NSApp.windows.contains { win in
            win.isVisible
            && win !== closedWindow
            && win !== self.statusItem?.button?.window
            && !win.isSwiftUIGhostWindow
        }
        if !hasVisibleWindows {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let onboarding = onboardingWindow {
            onboarding.bringToFront()
            return false
        }

        if authWindow != nil {
            authWindow?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return false
        }

        // Don't create the main window while bootstrap is in progress —
        // the bootstrap task will create it with the wake-up greeting
        // once the daemon is connected.
        if isBootstrapping { return false }

        // No assistant hatched yet — re-show onboarding so the user
        // can complete setup instead of landing on a broken main window.
        if !lockfileHasAssistants() && mainWindow == nil {
            showOnboarding()
            return false
        }

        showMainWindow()
        return false
    }
}

// MARK: - Onboarding

extension AppDelegate {

    @objc func replayOnboarding() {
        guard onboardingWindow == nil else { return }

        // Ensure daemon connectivity for the interview step
        if !connectionManager.isConnected {
            setupGatewayConnectionManager()
        }

        // Track whether the main window was visible so we can restore it
        // only when appropriate (e.g. not when invoked from the menu bar
        // with no main window open).
        let mainWindowWasVisible = mainWindow?.isVisible ?? false
        if mainWindowWasVisible {
            mainWindow?.hide()
        }

        // Clear persisted step so replay always starts at step 0
        OnboardingState.clearPersistedState()

        let onboarding = OnboardingWindow(
            connectionManager: connectionManager,
            authManager: authManager
        )
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil

            // Clear any stale panel state so the user lands on chat, not settings
            UserDefaults.standard.removeObject(forKey: "lastActivePanel")

            self?.showMainWindow()
        }
        onboarding.onDismiss = { [weak self] in
            self?.onboardingWindow = nil
            if mainWindowWasVisible {
                self?.showMainWindow()
            }
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    /// Hatches a new assistant via onboarding and auto-switches to it on success.
    /// Unlike `replayOnboarding()`, this method detects the newly created assistant
    /// and makes it the active one.
    func hatchNewAssistant() {
        guard onboardingWindow == nil else { return }

        if !connectionManager.isConnected {
            setupGatewayConnectionManager()
        }

        // Snapshot existing assistant IDs so we can detect the new one after hatch
        let existingIds = Set(LockfileAssistant.loadAll().map(\.assistantId))

        // Hide the main window during hatch to avoid showing stale old-assistant UI
        let mainWindowWasVisible = mainWindow?.isVisible ?? false
        if mainWindowWasVisible {
            mainWindow?.hide()
        }

        OnboardingState.clearPersistedState()

        let onboarding = OnboardingWindow(connectionManager: connectionManager, authManager: authManager)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil
            UserDefaults.standard.removeObject(forKey: "lastActivePanel")

            // Detect the newly hatched assistant by diffing lockfile against snapshot.
            // loadAll() returns newest-first, so the first new ID is the most recently hatched.
            let allAssistants = LockfileAssistant.loadAll()
            let newAssistant = allAssistants.first { !existingIds.contains($0.assistantId) }

            if let assistant = newAssistant {
                self?.performSwitchAssistant(to: assistant)
            } else {
                // No new assistant detected (e.g. managed bootstrap set connectedAssistantId
                // but reused an existing entry). Check if connectedAssistantId changed.
                if let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
                   !existingIds.isEmpty,
                   let connected = allAssistants.first(where: { $0.assistantId == connectedId }) {
                    self?.performSwitchAssistant(to: connected)
                } else {
                    self?.showMainWindow()
                }
            }
        }
        onboarding.onDismiss = { [weak self] in
            self?.onboardingWindow = nil
            if mainWindowWasVisible {
                self?.showMainWindow()
            }
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    /// Returns `true` when `~/.vellum.lock.json` contains at least one
    /// assistant entry.
    func lockfileHasAssistants() -> Bool {
        let primaryPath = LockfilePaths.primaryPath
        let fileExists = FileManager.default.fileExists(atPath: primaryPath)
        log.info("[lockfileCheck] primaryPath=\(primaryPath, privacy: .public) exists=\(fileExists)")

        guard let json = LockfilePaths.read() else {
            log.warning("[lockfileCheck] LockfilePaths.read() returned nil")
            return false
        }

        guard let assistants = json["assistants"] as? [[String: Any]] else {
            log.warning("[lockfileCheck] lockfile has no 'assistants' array")
            return false
        }

        log.info("[lockfileCheck] found \(assistants.count) assistant(s)")
        return !assistants.isEmpty
    }

    /// Check whether the local gateway is healthy by hitting its /healthz endpoint.
    /// Port resolution: env var > lockfile > default 7830.
    func isGatewayHealthy() async -> Bool {
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let port = LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId)
        guard let url = URL(string: "http://localhost:\(port)/healthz") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                return true
            }
        } catch {
            // Gateway not reachable — not healthy
        }
        return false
    }

    /// Remove a specific assistant entry from the lockfile. Used after a
    /// failed retire + Force Remove to clean up the stale entry so the
    /// next onboarding run starts with a fresh lockfile.
    func removeLockfileEntry(assistantId: String) {
        guard let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]] else {
            return
        }
        let filtered = assistants.filter { ($0["assistantId"] as? String) != assistantId }
        var updated = json
        updated["assistants"] = filtered
        do {
            let data = try JSONSerialization.data(withJSONObject: updated, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: LockfilePaths.primary)
            log.info("Removed stale entry '\(assistantId, privacy: .public)' from lockfile")
        } catch {
            log.error("Failed to update lockfile after removing '\(assistantId, privacy: .public)': \(error)")
        }
    }

    func showOnboarding() {
        let onboarding = OnboardingWindow(connectionManager: connectionManager, authManager: authManager)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil

            // Clear any stale panel state so the user lands on chat, not settings
            UserDefaults.standard.removeObject(forKey: "lastActivePanel")

            // Retain the onboarding state so the first-launch bootstrap can
            // read the randomly-generated avatar traits and sync them to the daemon.
            self?.onboardingState = state

            // By this point the user has either entered an API key (steps 0→1→2)
            // or authenticated via Vellum Account (WorkOS). Proceed directly —
            // don't re-check auth, which would show the auth gate again.
            self?.proceedToApp(isFirstLaunch: true)
        }
        onboarding.onDismiss = { [weak self] in
            self?.onboardingWindow = nil
            self?.onboardingState = nil
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    // MARK: - Wake-Up Greeting

    func wakeUpGreeting() -> String {
        return "Wake up, my friend."
    }
}

// MARK: - Main Window

extension AppDelegate {

    /// Creates the MainWindow and wires callbacks, without showing it.
    /// Safe to call multiple times — no-ops if mainWindow already exists.
    @discardableResult
    func ensureMainWindowExists(isFirstLaunch: Bool = false) -> MainWindow {
        if let existing = mainWindow { return existing }
        let main = MainWindow(services: services, updateManager: updateManager, isFirstLaunch: isFirstLaunch)
        main.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        main.conversationManager.onInlineConfirmationResponse = { [weak self] requestId, decision in
            guard let self else { return }
            self.toolConfirmationNotificationService.handleInlineResponse(requestId: requestId)
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: ["tool-confirm-\(requestId)"]
            )
        }
        mainWindow = main
        observeAssistantStatus()
        observeConversationBadge(main.conversationManager)
        return main
    }

    /// Debounce interval for `showMainWindow`.  Rapid calls within this
    /// window are skipped when the main window is already visible.
    private static let showMainWindowDebounceInterval: TimeInterval = 0.5

    func showMainWindow(initialMessage: String? = nil, isFirstLaunch: Bool = false) {
        // Centralized bootstrap guard: non-first-launch callers (dock reopen,
        // hotkey, menu bar) must not create the window during bootstrap.
        // The bootstrap task itself passes isFirstLaunch: true to bypass this.
        if isBootstrapping && !isFirstLaunch { return }

        // Debounce: if the window is already visible and we were called
        // very recently (< 500ms), skip the redundant show cycle.  This
        // prevents concurrent daemon callbacks from triggering multiple
        // activation-policy transitions in quick succession.
        let now = CFAbsoluteTimeGetCurrent()
        if mainWindow?.isVisible == true,
           now - lastShowMainWindowTime < Self.showMainWindowDebounceInterval {
            return
        }
        lastShowMainWindowTime = now

        if let existing = mainWindow {
            existing.show()
            refreshDockConversationBadge()
            return
        }
        let main = ensureMainWindowExists(isFirstLaunch: isFirstLaunch)
        // On first launch, defer the wake-up message until after the
        // "coming alive" transition so the animation plays uninterrupted.
        // For non-first-launch cases, send the message immediately so
        // SwiftUI never renders the empty state.
        if let message = initialMessage {
            if isFirstLaunch {
                main.pendingWakeUpMessage = message
            } else if let viewModel = main.activeViewModel {
                viewModel.inputText = message
                viewModel.sendMessage()
            }
        }
        main.show()
        refreshDockConversationBadge()
    }

    func observeAssistantStatus() {
        // Subscribe to active ChatViewModel's objectWillChange so menu bar icon
        // updates when isThinking or errorText changes, even though SwiftUI
        // views now use ActiveChatViewWrapper for their own observation.
        //
        // Use the emitted UUID directly (not activeViewModel) because $activeConversationId
        // fires during willSet — at that point activeConversationId still holds the old value,
        // so activeViewModel would resolve to the previous conversation's view model.
        statusIconCancellable = mainWindow?.conversationManager.$activeConversationId
            .compactMap { [weak mainWindow] (id: UUID?) -> ChatViewModel? in
                guard let id else { return nil }
                return mainWindow?.conversationManager.chatViewModel(for: id)
            }
            .handleEvents(receiveOutput: { [weak self] _ in
                // Update immediately when switching conversations
                self?.updateMenuBarIcon()
            })
            .map { $0.objectWillChange }
            .switchToLatest()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.updateMenuBarIcon()
            }
    }

    func observeConversationBadge(_ conversationManager: ConversationManager) {
        conversationBadgeCancellable?.cancel()

        applyDockConversationBadge(count: conversationManager.unseenVisibleConversationCount)

        conversationBadgeCancellable = conversationManager.$conversations
            .map { conversations in conversations.filter { !$0.isArchived && $0.kind != .private && $0.hasUnseenLatestAssistantMessage }.count }
            .removeDuplicates()
            .sink { [weak self] count in
                self?.applyDockConversationBadge(count: count)
            }
    }

    /// Format the unseen conversation count for the dock badge.
    /// Returns nil for 0 (clears badge), exact string for 1-99, "99+" for 100+.
    func formatDockConversationBadge(count: Int) -> String? {
        if count <= 0 { return nil }
        if count >= 100 { return "99+" }
        return "\(count)"
    }

    func applyDockConversationBadge(count: Int) {
        NSApp.dockTile.badgeLabel = formatDockConversationBadge(count: count)
        // Activation-policy transitions can recreate Dock tile presentation;
        // force a redraw so badge updates are immediately reflected.
        NSApp.dockTile.display()
    }

    func refreshDockConversationBadge() {
        applyDockConversationBadge(count: mainWindow?.conversationManager.unseenVisibleConversationCount ?? 0)
    }
}

// MARK: - About Panel & Settings

extension AppDelegate {

    public func showAboutPanel() {
        // Focus existing window if it's still open
        if let existing = aboutWindow, existing.isVisible {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let aboutView = AboutVellumView(connectionManager: connectionManager)
        let hostingController = NSHostingController(rootView: aboutView)

        let window = NSWindow(
            contentRect: .zero,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.title = "About \(Self.appName)"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(VColor.surfaceBase)
        window.isReleasedWhenClosed = false
        window.center()

        aboutWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Opens the settings panel in the main window.
    /// All entry points (Cmd+,, menu bar, onboarding skip, task input) use this.
    @objc public func showSettingsWindow(_ sender: Any?) {
        showMainWindow()
        mainWindow?.windowState.selection = .panel(.settings)
    }

    /// Opens the settings panel and navigates to a specific tab.
    public func showSettingsTab(_ tab: String) {
        // Don't gate on feature flags here — let SettingsPanel decide visibility
        // based on its own flag state when it processes pendingSettingsTab.
        // Use a switch to resolve legacy tab names (e.g. "Archived Threads")
        // without gating on feature flags.
        let settingsTab: SettingsTab?
        switch tab {
        case "Archived Threads": settingsTab = .archivedConversations
        default: settingsTab = SettingsTab(rawValue: tab)
        }
        if let settingsTab {
            services.settingsStore.pendingSettingsTab = settingsTab
        }
        showSettingsWindow(nil)
    }
}
