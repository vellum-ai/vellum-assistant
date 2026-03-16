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

    func showAuthWindow(reusingWindow existingWindow: NSWindow? = nil) {
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

        let window: NSWindow
        if let existingWindow {
            window = existingWindow
            window.contentViewController = hostingController
            window.isMovableByWindowBackground = true
            window.backgroundColor = NSColor(VColor.surfaceOverlay)
            window.contentMinSize = NSSize(width: 420, height: 580)
            window.setFrameAutosaveName("")

            let targetWidth: CGFloat = 460
            let targetHeight: CGFloat = 620
            let currentFrame = window.frame
            let newFrame = NSRect(
                x: currentFrame.midX - targetWidth / 2,
                y: currentFrame.midY - targetHeight / 2,
                width: targetWidth,
                height: targetHeight
            )
            window.setFrame(newFrame, display: true, animate: true)
        } else {
            window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 620),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.contentViewController = hostingController
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
            window.backgroundColor = NSColor(VColor.surfaceOverlay)
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
        }

        NSApp.activateAsDockAppIfNeeded()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        authWindow = window
    }

    @objc func performRestart() {
        let bundleURL = Bundle.main.bundleURL

        // Write a timestamped sentinel so the new instance's single-instance
        // guard knows this is an intentional restart, not a duplicate launch.
        // The sentinel contains the current Unix timestamp; the new instance
        // honours it only if it is less than 30 seconds old, so a stale file
        // left by a crash does not permanently disable the guard.
        let sentinelDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".vellum")
        try? FileManager.default.createDirectory(at: sentinelDir, withIntermediateDirectories: true)
        let sentinelPath = sentinelDir.appendingPathComponent("restart-in-progress")
        let timestamp = "\(Date().timeIntervalSince1970)"
        try? timestamp.write(to: sentinelPath, atomically: true, encoding: .utf8)

        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: bundleURL, configuration: config) { [weak self] _, error in
            if let error {
                log.error("Restart failed — could not launch new instance: \(error.localizedDescription)")
                // Clean up the sentinel so a failed restart doesn't leave
                // a file that could bypass the guard on the next launch.
                try? FileManager.default.removeItem(at: sentinelPath)
                return
            }
            DispatchQueue.main.async {
                self?.assistantCli.stop()
                NSApp.terminate(nil)
            }
        }
    }

    @objc public func performLogout() {
        Task {
            // Capture assistant ID before logout clears it from UserDefaults
            let connectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId")

            // Capture actor token before logout clears session state
            let actorToken = ActorTokenManager.getToken()

            await authManager.logout()

            // Clear managed proxy credentials from the running daemon (local assistants only)
            if !isCurrentAssistantManaged && !isCurrentAssistantRemote {
                if let token = actorToken, !token.isEmpty {
                    let assistantId = connectedAssistantId ?? ""
                    let port = LockfileAssistant.loadByName(assistantId)?.daemonPort ?? 7821
                    let daemonBaseURL = "http://localhost:\(port)"
                    let cleared = await LocalAssistantBootstrapService.clearDaemonCredentials(
                        daemonBaseURL: daemonBaseURL,
                        daemonToken: token
                    )
                    if !cleared {
                        log.warning("Credential cleanup incomplete — stopping daemon to prevent stale managed proxy state")
                        daemonClient.disconnect()
                        assistantCli.stop(name: connectedAssistantId)
                    }
                } else {
                    log.warning("No actor token available during logout — stopping daemon to ensure stale credentials are not retained")
                    daemonClient.disconnect()
                    assistantCli.stop(name: connectedAssistantId)
                }
            }

            // Clear locally-cached credentials from Keychain for all local assistants
            let keychainStorage = KeychainCredentialStorage()
            for assistant in LockfileAssistant.loadAll() where !assistant.isRemote && !assistant.isManaged {
                let credentialAccount = LocalAssistantBootstrapService.credentialAccount(for: assistant.assistantId)
                _ = keychainStorage.delete(account: credentialAccount)
            }
            // Also clear for the connected assistant in case it's not in the lockfile
            if let assistantId = connectedAssistantId {
                let credentialAccount = LocalAssistantBootstrapService.credentialAccount(for: assistantId)
                _ = keychainStorage.delete(account: credentialAccount)
            }

            // Stop all non-current local daemons to clear in-memory managed proxy
            // credentials. Assistant switches intentionally leave old daemons running
            // for fast switching, but on full logout there's no reason to keep them
            // alive with potentially stale state.
            for assistant in LockfileAssistant.loadAll() where !assistant.isRemote && !assistant.isManaged {
                if assistant.assistantId != connectedAssistantId {
                    if let instanceDir = assistant.instanceDir {
                        let env = ["BASE_DATA_DIR": instanceDir]
                        let pidPath = VellumAssistantShared.resolvePidPath(environment: env)
                        if let data = try? Data(contentsOf: URL(fileURLWithPath: pidPath)),
                           let pidString = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                           let pid = pid_t(pidString),
                           kill(pid, 0) == 0 {
                            kill(pid, SIGTERM)
                            log.info("Stopped daemon for assistant \(assistant.assistantId, privacy: .public) (pid \(pid))")
                        }
                    }
                }
            }

            // Reset dock icon to default before tearing down UI
            AvatarAppearanceManager.shared.resetForDisconnect()

            let detachedWindow = mainWindow?.detachWindow()
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

            hasSetupApp = false
            hasSetupDaemon = false
            showAuthWindow(reusingWindow: detachedWindow)
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
    /// 10s, so that assistant switches (which clear then re-bootstrap actor
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

        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"), !assistantId.isEmpty else {
            log.warning("Skipping local assistant API key provisioning because connectedAssistantId is not set")
            return
        }

        log.info("Starting local assistant API key provisioning for \(assistantId, privacy: .public)")

        Task {
            // Wait for the actor token — GatewayHTTPClient requires it for
            // auth and will throw immediately if it's not available yet.
            if ActorTokenManager.getToken()?.isEmpty != false {
                var token: String?
                for attempt in 1...6 {
                    token = await ActorTokenManager.waitForToken(timeout: 10)
                    if token != nil { break }
                    log.info("Actor token not yet available (attempt \(attempt)/6), retrying...")
                }
                guard token != nil else {
                    log.warning("No actor token available for local API key provisioning after 60s")
                    return
                }
            }

            do {
                let credentialStorage = KeychainCredentialStorage()
                let bootstrapService = LocalAssistantBootstrapService(credentialStorage: credentialStorage)
                let outcome = try await bootstrapService.bootstrap(
                    runtimeAssistantId: assistantId,
                    clientPlatform: "macos"
                )
                switch outcome {
                case .registeredWithExistingKey(let id):
                    log.info("Local assistant API key re-synced to daemon: \(id, privacy: .public)")
                case .registeredAndProvisioned(let id):
                    log.info("Local assistant API key provisioned: \(id, privacy: .public)")
                }
                NotificationCenter.default.post(name: .localBootstrapCompleted, object: nil)
            } catch {
                log.error("Failed to provision local assistant API key: \(error.localizedDescription)")
                self.mainWindow?.windowState.showToast(
                    message: "Failed to set up Vellum credentials. You may need to sign out and sign in again.",
                    style: .error
                )
            }
        }
    }

    /// Switches the app to a different lockfile assistant: stops the current
    /// daemon, resets assistant-scoped state, updates persisted state, and
    /// restarts with the new assistant.
    ///
    /// The sequence is intentionally ordered to avoid stale references:
    /// 1. Clear assistant-scoped runtime state (recording, windows, callbacks)
    /// 2. Disconnect transport (leave old daemon running)
    /// 3. Persist the new assistant selection
    /// 4. Reconfigure daemon transport and reconnect
    /// 5. Resume credential bootstrap
    func performSwitchAssistant(to assistant: LockfileAssistant) {
        // 1. Clear assistant-scoped runtime state while the daemon is still
        // running so forceStop can deliver a recording_status message.
        recordingManager.forceStop()
        recordingHUDWindow?.dismiss()

        // 2. Disconnect transport — leave the old daemon running so it stays
        //    awake and can be switched back to without a cold start.
        daemonClient.disconnect()
        // Reset dock icon to default before loading the new assistant's avatar
        AvatarAppearanceManager.shared.resetForDisconnect()
        // Close and recreate the main window to reset thread/session state
        mainWindow?.close()
        mainWindow = nil

        // 3. Persist the new assistant selection
        UserDefaults.standard.set(assistant.assistantId, forKey: "connectedAssistantId")
        SentryDeviceInfo.updateAssistantTag(assistant.assistantId)
        // Clear stale org ID so the next bootstrap re-resolves it for the new assistant
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        // Clear stale actor token for the previous assistant
        actorTokenBootstrapTask?.cancel()
        actorTokenBootstrapTask = nil
        ActorTokenManager.deleteToken()

        // 4. Reconfigure daemon transport and reconnect
        hasSetupDaemon = false
        setupDaemonClient()

        // 5. Resume credential bootstrap and show UI
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }
        ensureLocalAssistantApiKey()

        // 6. Sync locally-stored API keys to the new daemon. The daemon may
        //    have started without ANTHROPIC_API_KEY in its environment (e.g.
        //    when the app was launched via Finder/open). Push keys from
        //    UserDefaults so the daemon can initialize its LLM providers.
        syncApiKeysToAssistant(assistant)

        // Reload avatar for the new assistant (customAvatarURL now resolves
        // to the new assistant's path after connectedAssistantId was updated).
        AvatarAppearanceManager.shared.reloadAvatar()

        showMainWindow()
    }

    /// Push all locally-stored API keys to a specific assistant's daemon.
    /// Waits for the actor token, then POSTs each key to /v1/secrets.
    private func syncApiKeysToAssistant(_ assistant: LockfileAssistant) {
        let port = assistant.daemonPort
            ?? Int(ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "")
            ?? 7821

        Task {
            // Wait for the actor token (new daemon needs time to bootstrap).
            guard let token = await ActorTokenManager.waitForToken(timeout: 30),
                  !token.isEmpty else {
                log.warning("syncApiKeysToAssistant: no actor token after 30s, skipping key sync")
                return
            }

            for name in APIKeyManager.allSyncableProviders {
                guard let key = APIKeyManager.getKey(for: name), !key.isEmpty else { continue }
                guard let url = URL(string: "http://localhost:\(port)/v1/secrets") else { continue }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.timeoutInterval = 5
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                let body: [String: String] = ["type": "api_key", "name": name, "value": key]
                request.httpBody = try? JSONSerialization.data(withJSONObject: body)
                _ = try? await URLSession.shared.data(for: request)
            }

            // ElevenLabs uses the credential type, not api_key
            if let elevenLabsKey = APIKeyManager.getKey(for: "elevenlabs"), !elevenLabsKey.isEmpty {
                if let url = URL(string: "http://localhost:\(port)/v1/secrets") {
                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.timeoutInterval = 5
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    let body: [String: String] = ["type": "credential", "name": "elevenlabs:api_key", "value": elevenLabsKey]
                    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
                    _ = try? await URLSession.shared.data(for: request)
                }
            }

            log.info("syncApiKeysToAssistant: pushed API keys to daemon on port \(port)")
        }
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
                    return false
                }
                // Retire failed but user chose Force Remove — stop the daemon
                // before cleaning up local state.
                daemonClient.disconnect()
                assistantCli.stop(name: name)
                self.removeLockfileEntry(assistantId: name)
            }

            // Disconnect the client from the (now-dead) daemon.
            // The retire CLI already stopped the daemon process; an
            // additional assistantCli.stop() here would block the main
            // thread and always fail because the process is already gone.
            daemonClient.disconnect()
        } else {
            assistantCli.stop(name: assistantName)
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
        AvatarAppearanceManager.shared.resetForDisconnect()
        OnboardingState.clearPersistedState()
        UserDefaults.standard.removeObject(forKey: "bootstrapState")
        UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
        SentryDeviceInfo.updateAssistantTag(nil)
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        UserDefaults.standard.removeObject(forKey: "lastActivePanel")

        daemonClient.disconnect()
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

    // MARK: - Uninstall

    /// Retires all local assistants registered in the lockfile, then moves
    /// the application bundle to the Trash and terminates.
    ///
    /// Shows a confirmation alert before proceeding. Each local assistant is
    /// retired sequentially via the CLI; failures are logged but do not block
    /// subsequent retires or the final app removal.
    public func performUninstall() {
        let alert = NSAlert()
        alert.messageText = "Uninstall Vellum"
        alert.informativeText = "This will retire all local assistants and move Vellum to the Trash. This action cannot be undone."
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")

        guard alert.runModal() == .alertFirstButtonReturn else { return }

        Task {
            let allAssistants = LockfileAssistant.loadAll()
            let localAssistants = allAssistants.filter { !$0.isRemote }

            // Retire each local assistant so cloud/daemon resources are cleaned up.
            for assistant in localAssistants {
                do {
                    log.info("Retiring local assistant '\(assistant.assistantId, privacy: .private)' as part of uninstall")
                    try await assistantCli.retire(name: assistant.assistantId)
                } catch {
                    log.error("Failed to retire '\(assistant.assistantId, privacy: .private)' during uninstall: \(error.localizedDescription)")
                }
            }

            // Stop any remaining daemon processes.
            daemonClient.disconnect()
            assistantCli.stop()

            // Move the app bundle to the Trash.
            let bundleURL = Bundle.main.bundleURL
            do {
                try FileManager.default.trashItem(at: bundleURL, resultingItemURL: nil)
                log.info("Moved app bundle to Trash")
            } catch {
                log.error("Failed to move app to Trash: \(error.localizedDescription)")
                let failAlert = NSAlert()
                failAlert.messageText = "Could Not Remove Vellum"
                failAlert.informativeText = "All assistants have been retired, but the app could not be moved to the Trash: \(error.localizedDescription)\n\nYou can manually drag Vellum to the Trash."
                failAlert.alertStyle = .warning
                failAlert.addButton(withTitle: "OK")
                failAlert.runModal()
            }

            NSApp.terminate(nil)
        }
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
