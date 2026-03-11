import AppKit
import Combine
import SwiftUI
import UserNotifications
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

// MARK: - Surface Wiring

extension AppDelegate {

    func setupSurfaceManager() {
        daemonClient.onSurfaceShow = { [weak self] msg in
            guard let self else { return }
            self.surfaceManager.showSurface(msg)
        }
        daemonClient.onSurfaceUpdate = { [weak self] msg in
            guard let self else { return }
            self.surfaceManager.updateSurface(msg)
        }
        daemonClient.onSurfaceDismiss = { [weak self] msg in
            guard let self else { return }
            self.surfaceManager.dismissSurface(msg)
        }

        // Reload webviews for surfaces whose app files changed (cross-session broadcast)
        daemonClient.onAppFilesChanged = { [weak self] appId in
            guard let self else { return }
            self.refreshAppsCache()
            for (surfaceId, appSurfaceId) in self.surfaceManager.surfaceAppIds {
                guard appSurfaceId == appId else { continue }
                self.surfaceManager.surfaceCoordinators[surfaceId]?.webView?.reload()
            }
        }

        // Wire SurfaceManager action callback to DaemonClient
        surfaceManager.onAction = { [weak self] sessionId, surfaceId, actionId, data in
            guard let self else { return }
            let codableData: [String: AnyCodable]? = data?.mapValues { AnyCodable($0) }
            do {
                try self.daemonClient.sendSurfaceAction(
                    sessionId: sessionId,
                    surfaceId: surfaceId,
                    actionId: actionId,
                    data: codableData
                )
            } catch {
                log.error("Failed to send surface action \(actionId) for surface \(surfaceId): \(error)")
            }
        }

        // Data request: JS -> Swift -> daemon
        surfaceManager.onDataRequest = { [weak self] surfaceId, callId, method, appId, recordId, data in
            guard let self else { return }
            let codableData = data?.mapValues { AnyCodable($0) }
            do {
                try self.daemonClient.send(AppDataRequestMessage(
                    surfaceId: surfaceId,
                    callId: callId,
                    method: method,
                    appId: appId,
                    recordId: recordId,
                    data: codableData
                ))
            } catch {
                log.error("Failed to send app data request (method: \(method), appId: \(appId)): \(error)")
            }
        }

        // Data response: daemon -> Swift -> JS
        daemonClient.onAppDataResponse = { [weak self] msg in
            self?.surfaceManager.resolveDataResponse(surfaceId: msg.surfaceId, response: msg)
        }

        // Link open: JS -> Swift -> daemon
        surfaceManager.onLinkOpen = { [weak self] url, metadata in
            guard let self else { return }
            let codableMetadata = metadata?.mapValues { AnyCodable($0) }
            do {
                try self.daemonClient.sendLinkOpenRequest(url: url, metadata: codableMetadata)
            } catch {
                log.error("Failed to send link open request for \(url): \(error)")
            }
        }

        // Forward layout config from daemon to MainWindowState
        daemonClient.onLayoutConfig = { [weak self] msg in
            self?.mainWindow?.windowState.applyLayoutConfig(msg)
        }

        // Route dynamic pages to workspace
        surfaceManager.onDynamicPageShow = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.showMainWindow()
            NotificationCenter.default.post(
                name: .openDynamicWorkspace,
                object: nil,
                userInfo: ["surfaceMessage": msg]
            )
        }
    }

    func setupToolConfirmationNotifications() {
        daemonClient.onConfirmationRequest = { [weak self] msg in
            guard let self else { return }
            Task { @MainActor in
                // Auto-approve low/medium risk tool confirmations during CU sessions
                // or voice-initiated text_qa sessions pending escalation
                let isVoiceAutoApprove = msg.sessionId.map { self.autoApproveEscalationSessionIds.contains($0) } ?? false
                if (self.currentSession?.autoApproveTools == true || isVoiceAutoApprove),
                   msg.riskLevel == "low" || msg.riskLevel == "medium" {
                    do {
                        try self.daemonClient.sendConfirmationResponse(
                            requestId: msg.requestId,
                            decision: "allow"
                        )
                        self.mainWindow?.threadManager.updateConfirmationStateAcrossThreads(
                            requestId: msg.requestId,
                            decision: "allow"
                        )
                    } catch {
                        log.error("Failed to auto-approve confirmation: \(error.localizedDescription)")
                    }
                    return
                }

                // When the chat window is visible AND the confirmation belongs to the
                // active thread, the inline ToolConfirmationBubble handles the
                // confirmation UX — skip the native notification to avoid showing a
                // duplicate prompt.  If the confirmation is for a background thread,
                // the inline bubble won't be visible, so we must still fire the
                // native notification.
                if NSApp.isActive, let mainWindow = self.mainWindow, mainWindow.isVisible {
                    let activeSessionId = mainWindow.threadManager.activeViewModel?.sessionId
                    let confirmationIsForActiveThread = msg.sessionId == nil || msg.sessionId == activeSessionId
                    if confirmationIsForActiveThread {
                        return
                    }
                }

                let decision = await self.toolConfirmationNotificationService.showConfirmation(msg)
                // If the inline chat path already forwarded the response, skip
                // the duplicate send and state update.
                guard decision != ToolConfirmationNotificationService.inlineHandledSentinel else {
                    return
                }
                do {
                    try self.daemonClient.sendConfirmationResponse(
                        requestId: msg.requestId,
                        decision: decision
                    )
                    // Only sync the inline message state if the send succeeded.
                    self.mainWindow?.threadManager.updateConfirmationStateAcrossThreads(
                        requestId: msg.requestId,
                        decision: decision
                    )
                } catch {
                    log.error("Failed to send confirmation response: \(error.localizedDescription)")
                }
            }
        }
    }

    func setupSecretPromptManager() {
        daemonClient.onSecretRequest = { [weak self] msg in
            self?.secretPromptManager.showPrompt(msg)
        }
        secretPromptManager.onResponse = { [weak self] requestId, value, delivery in
            guard let self else { return false }
            do {
                try self.daemonClient.sendSecretResponse(requestId: requestId, value: value, delivery: delivery)
                return true
            } catch {
                log.error("Failed to send secret response: \(error.localizedDescription)")
                return false
            }
        }
    }
}

// MARK: - Window Observer & Reopen

extension AppDelegate {

    func setupWindowObserver() {
        // Watch for Settings window closing to revert to accessory activation policy
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { [weak self] notification in
            // Queue is .main so we're already on the main thread
            MainActor.assumeIsolated {
                guard let self else { return }
                guard let window = notification.object as? NSWindow,
                      window.title.contains("Settings") || window.title.contains("Vellum") else { return }
                // Keep .regular if MainWindow exists; only revert for legacy menu-bar-only mode
                guard self.mainWindow == nil else { return }
                self.scheduleActivationPolicyRevert()
            }
        }
    }

    /// Revert to accessory activation policy after a short delay if no visible windows remain.
    func scheduleActivationPolicyRevert() {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let self else { return }
            guard let statusItem = self.statusItem else { return }
            let hasVisibleWindows = NSApp.windows.contains { $0.isVisible && $0 !== statusItem.button?.window }
            if !hasVisibleWindows {
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if onboardingWindow != nil { return true }

        if authWindow != nil {
            authWindow?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return true
        }

        // Don't create the main window while bootstrap is in progress —
        // the bootstrap task will create it with the wake-up greeting
        // once the daemon is connected.
        if isBootstrapping { return true }

        // No assistant hatched yet — re-show onboarding so the user
        // can complete setup instead of landing on a broken main window.
        if !lockfileHasAssistants() && mainWindow == nil {
            showOnboarding()
            return true
        }

        showMainWindow()
        return true
    }
}

// MARK: - Onboarding

extension AppDelegate {

    @objc func replayOnboarding() {
        guard onboardingWindow == nil else { return }

        // Ensure daemon connectivity for the interview step
        if !daemonClient.isConnected {
            setupDaemonClient()
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
            daemonClient: daemonClient,
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

        if !daemonClient.isConnected {
            setupDaemonClient()
        }

        // Snapshot existing assistant IDs so we can detect the new one after hatch
        let existingIds = Set(LockfileAssistant.loadAll().map(\.assistantId))

        // Hide the main window during hatch to avoid showing stale old-assistant UI
        let mainWindowWasVisible = mainWindow?.isVisible ?? false
        if mainWindowWasVisible {
            mainWindow?.hide()
        }

        OnboardingState.clearPersistedState()

        let onboarding = OnboardingWindow(daemonClient: daemonClient, authManager: authManager)
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
        let port = LockfilePaths.resolveGatewayPort()
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
        if filtered.isEmpty {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
            log.info("Removed lockfile (no entries remain after force-removing '\(assistantId, privacy: .private)')")
        } else {
            var updated = json
            updated["assistants"] = filtered
            do {
                let data = try JSONSerialization.data(withJSONObject: updated, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: LockfilePaths.primary)
                log.info("Removed stale entry '\(assistantId, privacy: .private)' from lockfile")
            } catch {
                log.error("Failed to update lockfile after removing '\(assistantId, privacy: .private)': \(error)")
            }
        }
    }

    func showOnboarding() {
        let onboarding = OnboardingWindow(daemonClient: daemonClient, authManager: authManager)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil

            // Clear any stale panel state so the user lands on chat, not settings
            UserDefaults.standard.removeObject(forKey: "lastActivePanel")

            // By this point the user has either entered an API key (steps 0→1→2)
            // or authenticated via Vellum Account (WorkOS). Proceed directly —
            // don't re-check auth, which would show the auth gate again.
            self?.proceedToApp(isFirstLaunch: true)
        }
        onboarding.onDismiss = { [weak self] in
            self?.onboardingWindow = nil
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
        let main = MainWindow(services: services, isFirstLaunch: isFirstLaunch)
        main.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        main.threadManager.onInlineConfirmationResponse = { [weak self] requestId, decision in
            guard let self else { return }
            self.toolConfirmationNotificationService.handleInlineResponse(requestId: requestId)
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: ["tool-confirm-\(requestId)"]
            )
        }
        mainWindow = main
        observeAssistantStatus()
        observeConversationBadge(main.threadManager)
        return main
    }

    func showMainWindow(initialMessage: String? = nil, isFirstLaunch: Bool = false) {
        // Centralized bootstrap guard: non-first-launch callers (dock reopen,
        // hotkey, menu bar) must not create the window during bootstrap.
        // The bootstrap task itself passes isFirstLaunch: true to bypass this.
        if isBootstrapping && !isFirstLaunch { return }

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
        // Use the emitted UUID directly (not activeViewModel) because $activeThreadId
        // fires during willSet — at that point activeThreadId still holds the old value,
        // so activeViewModel would resolve to the previous thread's view model.
        statusIconCancellable = mainWindow?.threadManager.$activeThreadId
            .compactMap { [weak mainWindow] (id: UUID?) -> ChatViewModel? in
                guard let id else { return nil }
                return mainWindow?.threadManager.chatViewModel(for: id)
            }
            .handleEvents(receiveOutput: { [weak self] _ in
                // Update immediately when switching threads
                self?.updateMenuBarIcon()
            })
            .map { $0.objectWillChange }
            .switchToLatest()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.updateMenuBarIcon()
            }
    }

    func observeConversationBadge(_ threadManager: ThreadManager) {
        conversationBadgeCancellable?.cancel()

        applyDockConversationBadge(count: threadManager.unseenVisibleConversationCount)

        conversationBadgeCancellable = threadManager.$threads
            .map { threads in threads.filter { !$0.isArchived && $0.kind != .private && $0.hasUnseenLatestAssistantMessage }.count }
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
        applyDockConversationBadge(count: mainWindow?.threadManager.unseenVisibleConversationCount ?? 0)
    }
}

// MARK: - About Panel & Settings

extension AppDelegate {

    public func showAboutPanel() {
        var options: [NSApplication.AboutPanelOptionKey: Any] = [:]

        #if DEBUG
        let bundlePath = Bundle.main.bundlePath
        let creditsString = NSMutableAttributedString()

        let headerAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.systemOrange
        ]
        creditsString.append(NSAttributedString(string: "Local Development Build\n", attributes: headerAttributes))

        let pathAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor
        ]
        creditsString.append(NSAttributedString(string: bundlePath, attributes: pathAttributes))

        options[.credits] = creditsString
        #endif

        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: options)
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
        if let settingsTab = SettingsTab(rawValue: tab) {
            services.settingsStore.pendingSettingsTab = settingsTab
        }
        showSettingsWindow(nil)
    }
}
