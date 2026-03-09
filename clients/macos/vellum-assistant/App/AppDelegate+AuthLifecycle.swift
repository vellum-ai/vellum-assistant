import AppKit
import Combine
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+AuthLifecycle")

// MARK: - Auth lifecycle: login, logout, restart, retire, switch assistant

extension AppDelegate {

    func startAuthenticatedFlow() {
        Task {
            await authManager.checkSession()
            let isAuthed = authManager.isAuthenticated
            let hasKey = APIKeyManager.hasAnyKey()
            log.info("[authFlow] isAuthenticated=\(isAuthed) hasAnyKey=\(hasKey)")
            if isAuthed || hasKey {
                log.info("[authFlow] → proceedToApp()")
                proceedToApp()
            } else {
                log.info("[authFlow] → showAuthWindow()")
                showAuthWindow()
            }
        }
    }

    func showAuthWindow() {
        if let existing = authWindow {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        OnboardingState.clearPersistedState()
        let state = OnboardingState()
        state.shouldPersist = false
        let authView = OnboardingFlowView(
            state: state,
            daemonClient: daemonClient,
            authManager: authManager,
            managedBootstrapEnabled: true,
            onComplete: { [weak self] in
                self?.proceedToApp()
            },
            onOpenSettings: {}
        )

        let hostingController = NSHostingController(rootView: authView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 420, height: 580)

        let startWidth: CGFloat = 460
        let startHeight: CGFloat = 620
        if let visibleFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame {
            let x = visibleFrame.midX - startWidth / 2
            let y = visibleFrame.midY - startHeight / 2
            window.setFrame(NSRect(x: x, y: y, width: startWidth, height: startHeight), display: true)
        } else {
            window.setContentSize(NSSize(width: startWidth, height: startHeight))
            window.center()
        }

        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        authWindow = window
    }

    @objc func performRestart() {
        let bundleURL = Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: bundleURL, configuration: config) { [weak self] _, error in
            if let error {
                log.error("Restart failed — could not launch new instance: \(error.localizedDescription)")
                return
            }
            DispatchQueue.main.async {
                self?.assistantCli.stop()
                NSApp.terminate(nil)
            }
        }
    }

    @objc func performLogout() {
        Task {
            await authManager.logout()

            mainWindow?.close()
            mainWindow = nil
            conversationBadgeCancellable?.cancel()
            conversationBadgeCancellable = nil
            NSApp.dockTile.badgeLabel = nil

            if let hotKeyMonitor {
                NSEvent.removeMonitor(hotKeyMonitor)
                self.hotKeyMonitor = nil
            }
            tearDownHotKeyState()
            quickInputWindow?.dismiss()
            quickInputWindow = nil
            globalHotkeyObserver?.cancel()
            globalHotkeyObserver = nil
            if let escapeMonitor {
                NSEvent.removeMonitor(escapeMonitor)
                self.escapeMonitor = nil
            }
            voiceInput?.stop()
            voiceInput = nil
            wakeWordErrorCancellable?.cancel()
            wakeWordErrorCancellable = nil
            wakeWordCoordinator = nil
            ambientAgent.teardown()

            if let observer = windowObserver {
                NotificationCenter.default.removeObserver(observer)
                windowObserver = nil
            }
            statusIconCancellable?.cancel()
            statusIconCancellable = nil
            connectionStatusCancellable?.cancel()
            connectionStatusCancellable = nil
            pulseTimer?.invalidate()
            pulseTimer = nil

            if let item = statusItem {
                NSStatusBar.system.removeStatusItem(item)
                statusItem = nil
            }

            if let mainMenu = NSApp.mainMenu {
                for title in ["File", "View"] {
                    let idx = mainMenu.indexOfItem(withTitle: title)
                    if idx >= 0 { mainMenu.removeItem(at: idx) }
                }
            }

            actorTokenBootstrapTask?.cancel()
            actorTokenBootstrapTask = nil
            ActorTokenManager.deleteToken()

            assistantCli.stopMonitoring()
            hasSetupApp = false
            hasSetupDaemon = false
            showAuthWindow()
        }
    }

    // MARK: - Local Assistant API Key Provisioning

    /// Ensures the current local assistant has a provisioned AssistantAPIKey
    /// and that the key is injected into the daemon's secret store.
    ///
    /// Safe to call at any time — exits early if the assistant is managed/remote
    /// or the user isn't authenticated. Always calls through to
    /// `LocalAssistantBootstrapService.bootstrap()` so existing-key re-injection
    /// and stale-key reprovisioning are handled (not just Keychain presence).
    ///
    /// Waits up to 60s for the actor token to become available, retrying every
    /// 5s, so that assistant switches (which clear then re-bootstrap actor
    /// credentials) don't race with this method.
    func ensureLocalAssistantApiKey() {
        guard !isCurrentAssistantManaged, !isCurrentAssistantRemote else {
            log.debug("Skipping local assistant API key provisioning because current assistant is managed=\(self.isCurrentAssistantManaged, privacy: .public) remote=\(self.isCurrentAssistantRemote, privacy: .public)")
            return
        }
        guard authManager.isAuthenticated else {
            log.debug("Skipping local assistant API key provisioning because user is not authenticated")
            return
        }

        let storedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        guard let assistantId = storedId,
              let assistant = LockfileAssistant.loadByName(assistantId) else {
            log.warning("Skipping local assistant API key provisioning because connectedAssistantId is missing from lockfile")
            return
        }

        // Resolve daemon HTTP endpoint from lockfile, with env override and fallback
        let daemonPort = assistant.daemonPort
            ?? Int(ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "")
            ?? 7821
        let daemonBaseURL = "http://localhost:\(daemonPort)"
        log.info("Starting local assistant API key provisioning for \(assistant.assistantId, privacy: .public) at \(daemonBaseURL, privacy: .public)")

        Task {
            // Wait for actor token with retries — initial bootstrap may take
            // longer than a single waitForToken timeout when the daemon is
            // still coming up or credentials are being rotated after a switch.
            let daemonToken: String
            if let token = ActorTokenManager.getToken(), !token.isEmpty {
                daemonToken = token
            } else {
                var token: String?
                for attempt in 1...6 {
                    token = await ActorTokenManager.waitForToken(timeout: 10)
                    if token != nil { break }
                    log.info("Actor token not yet available (attempt \(attempt)/6), retrying...")
                }
                guard let resolved = token else {
                    log.warning("No actor token available for local API key provisioning after 60s")
                    return
                }
                daemonToken = resolved
            }

            do {
                let credentialStorage = KeychainCredentialStorage()
                let bootstrapService = LocalAssistantBootstrapService(credentialStorage: credentialStorage)
                let outcome = try await bootstrapService.bootstrap(
                    runtimeAssistantId: assistant.assistantId,
                    clientPlatform: "macos",
                    daemonBaseURL: daemonBaseURL,
                    daemonToken: daemonToken
                )
                switch outcome {
                case .registeredWithExistingKey(let id):
                    log.info("Local assistant API key re-synced to daemon: \(id, privacy: .public)")
                case .registeredAndProvisioned(let id):
                    log.info("Local assistant API key provisioned: \(id, privacy: .public)")
                }
            } catch {
                log.error("Failed to provision local assistant API key: \(error.localizedDescription)")
            }
        }
    }

    /// Switches the app to a different lockfile assistant: stops the current
    /// daemon, resets assistant-scoped state, updates persisted state, and
    /// restarts with the new assistant.
    ///
    /// The sequence is intentionally ordered to avoid stale references:
    /// 1. Stop lifecycle monitoring
    /// 2. Clear assistant-scoped runtime state (recording, windows, callbacks)
    /// 3. Stop daemon processes and disconnect transport
    /// 4. Persist the new assistant selection
    /// 5. Reconfigure daemon transport and reconnect
    /// 6. Resume monitoring and credential bootstrap
    func performSwitchAssistant(to assistant: LockfileAssistant) {
        // 1. Stop lifecycle monitoring
        assistantCli.stopMonitoring()

        // 2. Clear assistant-scoped runtime state while the daemon is still
        // running so forceStop can deliver a recording_status IPC message.
        recordingManager.forceStop()
        recordingHUDWindow?.dismiss()

        // 3. Disconnect transport — leave the old daemon running so it stays
        //    awake and can be switched back to without a cold start.
        assistantCli.stopMonitoring()
        daemonClient.disconnect()
        // Close and recreate the main window to reset thread/session state
        mainWindow?.close()
        mainWindow = nil

        // Cancel any in-progress bootstrap tasks from the previous assistant
        bootstrapRetryTask?.cancel()
        bootstrapRetryTask = nil

        // 4. Persist the new assistant selection
        UserDefaults.standard.set(assistant.assistantId, forKey: "connectedAssistantId")
        // Clear stale org ID so the next bootstrap re-resolves it for the new assistant
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        assistant.writeToWorkspaceConfig()

        // Clear stale actor token for the previous assistant
        actorTokenBootstrapTask?.cancel()
        actorTokenBootstrapTask = nil
        ActorTokenManager.deleteToken()

        // 5. Reconfigure daemon transport and reconnect
        hasSetupDaemon = false
        setupDaemonClient()

        // 6. Resume credential bootstrap and show UI
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }
        ensureLocalAssistantApiKey()
        showMainWindow()
    }

    @objc func performRetire() {
        Task { await performRetireAsync() }
    }

    /// Async retire implementation callable from SwiftUI so callers can
    /// await completion and dismiss their loading UI.
    ///
    /// Returns `true` if the retire completed (or the user chose to force-remove),
    /// `false` if the user cancelled after a failure.
    @discardableResult
    func performRetireAsync() async -> Bool {
        let assistantName = UserDefaults.standard.string(forKey: "connectedAssistantId")

        if assistantName == nil {
            log.error("No stored connected assistant ID found — skipping retire")
        }

        if let name = assistantName {
            do {
                try await assistantCli.retire(name: name)
            } catch {
                log.error("CLI retire failed: \(error.localizedDescription)")
                let alert = NSAlert()
                alert.messageText = "Failed to Retire Remote Instance"
                alert.informativeText = "\(error.localizedDescription)\n\nYou can force-remove the local configuration, but the remote cloud instance may still be running and will need to be deleted manually."
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Force Remove")
                alert.addButton(withTitle: "Cancel")
                if alert.runModal() != .alertFirstButtonReturn {
                    // Daemon is still running — user can continue using the app.
                    // retire() already set isStopping=true and stopped monitoring;
                    // restart monitoring so the health check remains active.
                    assistantCli.startMonitoring()
                    return false
                }
                // Retire failed but user chose Force Remove — stop the daemon
                // before cleaning up local state.
                daemonClient.disconnect()
                assistantCli.stop()
                self.removeLockfileEntry(assistantId: name)
            }

            // Stop processes after retire succeeds (or user chose Force Remove).
            // This keeps the daemon alive if the user cancels a failed retire.
            daemonClient.disconnect()
            assistantCli.stop()
        } else {
            assistantCli.stop()
        }

        // Check if other assistants remain in the lockfile.
        // Prefer remote assistants (always reachable), then try waking local ones.
        let remaining = LockfileAssistant.loadAll().filter { $0.assistantId != assistantName }
        if !remaining.isEmpty {
            // Try remote assistants first — they're always reachable
            if let remote = remaining.first(where: { $0.isRemote }) {
                performSwitchAssistant(to: remote)
                return true
            }

            // Try local assistants — check if awake, otherwise wake them
            for candidate in remaining {
                let env: [String: String]? = candidate.instanceDir.map { ["BASE_DATA_DIR": $0] }
                if DaemonClient.isDaemonProcessAlive(environment: env) {
                    performSwitchAssistant(to: candidate)
                    return true
                }

                // Sleeping — try to wake it
                do {
                    try await assistantCli.wake(name: candidate.assistantId)
                    performSwitchAssistant(to: candidate)
                    return true
                } catch {
                    log.warning("Failed to wake \(candidate.assistantId): \(error.localizedDescription)")
                    continue
                }
            }
            // All local wake attempts failed — fall through to onboarding
        }

        // No assistants left — tear down fully and show onboarding
        OnboardingState.clearPersistedState()
        UserDefaults.standard.removeObject(forKey: "bootstrapState")
        UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        UserDefaults.standard.removeObject(forKey: "lastActivePanel")

        // Kill the daemon process so ensureDaemonRunning() actually spawns
        // a fresh instance during re-onboarding (equivalent to `vellum sleep`).
        daemonClient.disconnect()
        assistantCli.stop()
        // Cancel any in-progress bootstrap retry so it doesn't race with the
        // new onboarding flow.
        bootstrapRetryTask?.cancel()
        bootstrapRetryTask = nil
        actorTokenBootstrapTask?.cancel()
        actorTokenBootstrapTask = nil
        ActorTokenManager.deleteToken()

        mainWindow?.close()
        mainWindow = nil
        conversationBadgeCancellable?.cancel()
        conversationBadgeCancellable = nil
        NSApp.dockTile.badgeLabel = nil

        if let hotKeyMonitor {
            NSEvent.removeMonitor(hotKeyMonitor)
            self.hotKeyMonitor = nil
        }
        tearDownHotKeyState()
        quickInputWindow?.dismiss()
        quickInputWindow = nil
        globalHotkeyObserver?.cancel()
        globalHotkeyObserver = nil
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
        voiceInput?.stop()
        voiceInput = nil
        wakeWordErrorCancellable?.cancel()
        wakeWordErrorCancellable = nil
        wakeWordCoordinator = nil
        ambientAgent.teardown()

        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
            windowObserver = nil
        }
        statusIconCancellable?.cancel()
        statusIconCancellable = nil
        connectionStatusCancellable?.cancel()
        connectionStatusCancellable = nil
        pulseTimer?.invalidate()
        pulseTimer = nil

        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }

        if let mainMenu = NSApp.mainMenu {
            for title in ["File", "View"] {
                let idx = mainMenu.indexOfItem(withTitle: title)
                if idx >= 0 { mainMenu.removeItem(at: idx) }
            }
        }

        hasSetupApp = false
        hasSetupDaemon = false
        daemonClient.disconnect()
        UserDefaults.standard.removeObject(forKey: "user.profile")
        showOnboarding()
        return true
    }

    // MARK: - Shared teardown helpers

    /// Resets hotkey registration state so hotkeys are properly re-registered
    /// on the next login cycle. Called by both `performLogout` and `performRetireAsync`.
    ///
    /// Consolidates three bug fixes:
    /// 1. Resets `hasSetupHotKey` so `setupHotKey()` re-registers on next login
    /// 2. Clears both `lastRegisteredGlobalHotkey` and `lastRegisteredQuickInputHotkey`
    ///    so re-registration is not short-circuited
    /// 3. Tears down quick-input monitors (including `cmdKLocalMonitor`)
    func tearDownHotKeyState() {
        hasSetupHotKey = false
        lastRegisteredGlobalHotkey = nil
        lastRegisteredQuickInputHotkey = nil
        tearDownQuickInputMonitors()
    }
}
