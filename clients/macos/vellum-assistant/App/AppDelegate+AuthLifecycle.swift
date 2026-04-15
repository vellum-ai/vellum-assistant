import AppKit
import Combine
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+AuthLifecycle")

// MARK: - Auth lifecycle: login, logout, restart, retire, switch assistant

extension AppDelegate {

    func startAuthenticatedFlow() {
        Task {
            await authManager.checkSession()
            SentryDeviceInfo.updateUserTag(authManager.currentUser?.id)
            let isAuthed = authManager.isAuthenticated
            let hasKey = APIKeyManager.hasAnyKey()
            log.info("[authFlow] isAuthenticated=\(isAuthed) hasAnyKey=\(hasKey)")
            if isAuthed || hasKey {
                // Verify there is at least one assistant from the current
                // platform environment before entering the app. After a
                // retire the lockfile may only contain cross-environment
                // entries that cannot be connected to — in that case fall
                // through to onboarding so the user can hatch a new one.
                let hasConnectable = LockfileAssistant.loadAll().contains { $0.isCurrentEnvironment }
                if hasConnectable {
                    log.info("[authFlow] → proceedToApp()")
                    proceedToApp()
                } else {
                    log.info("[authFlow] Authenticated but no current-environment assistant — showing onboarding")
                    showAuthWindow()
                }
            } else {
                // Check if the lockfile has a non-managed assistant we can connect to
                // without authentication. Local/remote assistants run independently
                // of the platform auth session, so the app can open in a logged-out
                // state and the user can sign in from Settings > General.
                // Skip managed assistants from a different platform environment.
                // Migration: fall back to UserDefaults for users upgrading from
                // the old version whose lockfile doesn't yet have activeAssistant.
                let storedId = LockfileAssistant.loadActiveAssistantId()
                    ?? UserDefaults.standard.string(forKey: "connectedAssistantId")
                let assistant = storedId.flatMap { LockfileAssistant.loadByName($0) }
                    ?? LockfileAssistant.loadLatest()
                if let assistant, !assistant.isManaged, assistant.isCurrentEnvironment {
                    log.info("[authFlow] Lockfile has non-managed assistant \(assistant.assistantId) — proceeding to app without auth")
                    proceedToApp()
                } else {
                    log.info("[authFlow] → showAuthWindow()")
                    showAuthWindow()
                }
            }
        }
    }

    func showAuthWindow(reusingWindow existingWindow: NSWindow? = nil) {
        if let existing = authWindow {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hasManagedAssistants = LockfileAssistant.loadAll().contains { $0.isManaged && $0.isCurrentEnvironment }
        let authView: AnyView

        if hasManagedAssistants {
            // Returning managed user — show clean sign-in, not full onboarding
            authView = AnyView(ReauthView(
                authManager: authManager,
                onComplete: { [weak self] in
                    self?.proceedToApp()
                }
            ))
        } else {
            // No managed assistants — show full onboarding which includes
            // skip/authless flows for local and remote assistant setups
            OnboardingState.clearPersistedState()
            let state = OnboardingState()
            state.shouldPersist = false
            self.onboardingState = state
            authView = AnyView(OnboardingFlowView(
                state: state,
                connectionManager: connectionManager,
                authManager: authManager,
                managedBootstrapEnabled: true,
                onComplete: { [weak self] in
                    self?.proceedToApp()
                },
                onOpenSettings: {}
            ))
        }

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

        // Disconnect SSE and health checks *before* the CLI kills the
        // daemon/gateway.  Otherwise the health check detects the daemon
        // dying, triggers autoWakeIfAssistantDied(), and wakes the daemon
        // right back up — fighting with the shutdown.  (Same pattern as
        // performRetireAsync().)
        connectionManager.disconnect()

        // Write a timestamped sentinel so the new instance's single-instance
        // guard knows this is an intentional restart, not a duplicate launch.
        // The sentinel contains the current Unix timestamp; the new instance
        // honours it only if it is less than 30 seconds old, so a stale file
        // left by a crash does not permanently disable the guard.
        // Uses NSTemporaryDirectory() (per Apple guidelines for transient IPC
        // files) instead of ~/.vellum to avoid workspace disk assumptions.
        let sentinelPath = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vellum-restart-in-progress")
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
                // Reconnect SSE and health checks so the app doesn't stay
                // in a disconnected state after a failed relaunch attempt.
                // (Same pattern as performRetireAsync()'s cancel path.)
                Task { @MainActor [weak self] in
                    try? await self?.connectionManager.connect()
                }
                return
            }
            Task { @MainActor [weak self] in
                await self?.vellumCli.stop()
                self?.isRestarting = true
                NSApp.terminate(nil)
            }
        }
    }

    @objc public func performLogout() {
        // Cancel any in-flight managed switch so it doesn't reconnect after logout.
        managedSwitchTask?.cancel()
        managedSwitchTask = nil

        Task {
            // Capture assistant ID before logout clears it
            let connectedAssistantId = LockfileAssistant.loadActiveAssistantId()

            // Capture managed status before logout clears UserDefaults
            let wasManaged = isCurrentAssistantManaged

            if !wasManaged {
                await authManager.logoutWithToast { [weak self] msg, style in
                    self?.mainWindow?.windowState.showToast(message: msg, style: style)
                }

                // Restore activeAssistant immediately — authManager.logout()
                // clears it, but clearAssistantCredentials() needs it to resolve
                // the gateway connection via GatewayHTTPClient.
                // Without it, all DELETE requests fail with "No connected assistant",
                // triggering the fallback that disconnects and stops the assistant.
                // Do NOT restore connectedOrganizationId: the org ID may belong
                // to a different environment (e.g. dev vs prod). Letting bootstrap
                // re-resolve it on the next login ensures it matches the session.
                if let connectedAssistantId {
                    LockfileAssistant.setActiveAssistantId(connectedAssistantId)
                }
            } else {
                // Managed: user is redirected to the reauth screen regardless of
                // HTTP outcome, so we don't toast. Log the error for diagnostics —
                // the local session is always cleared and the stale server session
                // will expire naturally or be replaced on re-login.
                let logoutError = await authManager.logout()
                if let logoutError {
                    log.warning("Managed logout HTTP request failed (local session cleared): \(logoutError, privacy: .public)")
                }
            }

            // Clear platform identity credentials from the running assistant (local assistants only).
            // Skip when the assistant was never set up (e.g. logout during onboarding) —
            // there are no credentials to clear and no assistant to stop.
            if !isCurrentAssistantManaged && (!isCurrentAssistantRemote || isCurrentAssistantDocker) && hasSetupDaemon {
                let cleared = await LocalAssistantBootstrapService.clearAssistantCredentials()
                if !cleared {
                    log.warning("Credential cleanup incomplete — stopping assistant to prevent stale managed credential state")
                    connectionManager.disconnect()
                    await vellumCli.stop(name: connectedAssistantId)
                }
            }

            // Clear locally-cached credentials for all local assistants
            let credStorage = FileCredentialStorage()
            for assistant in LockfileAssistant.loadAll() where (!assistant.isRemote || assistant.isDocker) && !assistant.isManaged {
                LocalAssistantBootstrapService.clearBootstrapCredential(
                    runtimeAssistantId: assistant.assistantId,
                    credentialStorage: credStorage
                )
            }
            // Also clear for the connected assistant in case it's not in the lockfile
            if let assistantId = connectedAssistantId {
                LocalAssistantBootstrapService.clearBootstrapCredential(
                    runtimeAssistantId: assistantId,
                    credentialStorage: credStorage
                )
            }

            // Stop all non-current local assistant processes to clear in-memory platform
            // identity credentials. Assistant switches intentionally leave old processes
            // running for fast switching, but on full logout there's no reason to keep
            // them alive with potentially stale state.
            for assistant in LockfileAssistant.loadAll() where (!assistant.isRemote || assistant.isDocker) && !assistant.isManaged {
                if assistant.assistantId != connectedAssistantId {
                    do {
                        try await vellumCli.sleep(name: assistant.assistantId)
                    } catch {
                        log.warning("Failed to stop assistant \(assistant.assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    }
                }
            }

            // Reset dock icon to default before tearing down UI
            AvatarAppearanceManager.shared.resetForDisconnect()

            if !wasManaged {
                // Self-hosted (local or remote): clear auth state but keep the
                // app running. The user can sign in again from Settings > General.
                // connectedAssistantId was already restored above (before
                // clearAssistantCredentials). Preserve the actor token and gateway
                // connection — the actor token authenticates to the local gateway
                // (device-scoped, not user-scoped) and is independent of the
                // platform auth session.

                AvatarAppearanceManager.shared.reloadAvatar()
            } else {
                // Managed (platform): full teardown — close everything and
                // show the reauth screen.
                let detachedWindow = mainWindow?.detachWindow()
                mainWindow = nil
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
                UserDefaults.standard.removeObject(forKey: "managedServiceModesInitialized")
                showAuthWindow(reusingWindow: detachedWindow)
            }
        }
    }

    // MARK: - Local Assistant API Key Provisioning

    /// Ensures the current local assistant has a provisioned AssistantAPIKey
    /// and that the key is injected into the daemon's secret store.
    ///
    /// Safe to call at any time — exits early if the assistant is managed/remote
    /// or the user isn't authenticated. Always calls through to
    /// `LocalAssistantBootstrapService.bootstrap()` which idempotently registers
    /// the assistant and ensures a valid API key is injected.
    ///
    /// Waits up to 60s for the actor token to become available, retrying every
    /// 10s, so that assistant switches (which clear then re-bootstrap actor
    /// credentials) don't race with this method.
    func ensureLocalAssistantApiKey() {
        guard !isCurrentAssistantManaged, (!isCurrentAssistantRemote || isCurrentAssistantDocker) else {
            log.debug("Skipping local assistant API key provisioning because current assistant is managed=\(self.isCurrentAssistantManaged, privacy: .public) remote=\(self.isCurrentAssistantRemote, privacy: .public)")
            return
        }
        guard authManager.isAuthenticated else {
            log.debug("Skipping local assistant API key provisioning because user is not authenticated")
            return
        }

        guard let assistantId = LockfileAssistant.loadActiveAssistantId(), !assistantId.isEmpty else {
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

            // Wait for the assistant (and gateway) to be reachable. The bootstrap
            // injects credentials via GatewayHTTPClient which connects to the
            // local gateway — if we proceed before it's listening we get
            // "Could not connect to the server."
            if !self.connectionManager.isConnected {
                log.info("Waiting for assistant connection before credential bootstrap...")
                for attempt in 1...20 {
                    if self.connectionManager.isConnected { break }
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    if attempt == 20 {
                        log.warning("Assistant not connected after 10s — proceeding with credential bootstrap anyway")
                    }
                }
            }

            do {
                let credentialStorage = FileCredentialStorage()
                let bootstrapService = LocalAssistantBootstrapService(credentialStorage: credentialStorage)
                let platformId = try await bootstrapService.bootstrap(
                    runtimeAssistantId: assistantId,
                    clientPlatform: "macos",
                    assistantVersion: self.connectionManager.assistantVersion
                )
                log.info("Local assistant registered: \(platformId, privacy: .public)")

                self.localBootstrapDidComplete = true
                SentryDeviceInfo.updateOrganizationTag(UserDefaults.standard.string(forKey: "connectedOrganizationId"))
                NotificationCenter.default.post(name: .localBootstrapCompleted, object: nil)
            } catch {
                log.error("Failed to provision local assistant API key: \(error.localizedDescription)")
                self.localBootstrapDidComplete = true
                SentryDeviceInfo.updateOrganizationTag(UserDefaults.standard.string(forKey: "connectedOrganizationId"))
                NotificationCenter.default.post(name: .localBootstrapCompleted, object: nil)
                self.mainWindow?.windowState.showToast(
                    message: "Failed to set up Vellum credentials. You may need to log out and log in again.",
                    style: .error,
                    copyableDetail: error.localizedDescription
                )
            }
        }
    }

    /// Switches the app to a different lockfile assistant: stops the current
    /// assistant, resets assistant-scoped state, updates persisted state, and
    /// restarts with the new assistant.
    ///
    /// The sequence is intentionally ordered to avoid stale references:
    /// 1. Clear assistant-scoped runtime state (recording, windows, callbacks)
    /// 2. Disconnect transport (leave old assistant running)
    /// 3. Persist the new assistant selection
    /// 4. For managed assistants, bootstrap via the platform API to re-resolve
    ///    the organization ID (cleared in step 3) before connecting
    /// 5. Reconfigure transport and reconnect
    /// 6. Resume credential bootstrap
    func performSwitchAssistant(to assistant: LockfileAssistant) {
        // If switching to a managed assistant while logged out, prompt login first.
        if assistant.isManaged && !authManager.isAuthenticated {
            // Persist the target so we can switch after login completes.
            UserDefaults.standard.set(assistant.assistantId, forKey: "pendingManagedSwitchAssistantId")
            showAuthWindow()
            return
        }

        // 1. Clear assistant-scoped runtime state while the assistant is still
        // running so forceStop can deliver a recording_status message.
        recordingManager.forceStop()
        recordingHUDWindow?.dismiss()

        // 2. Disconnect transport — leave the old assistant running so it stays
        //    awake and can be switched back to without a cold start.
        connectionManager.disconnect()
        // Reset dock icon to default before loading the new assistant's avatar
        AvatarAppearanceManager.shared.resetForDisconnect()
        // Close pop-out thread windows before tearing down the main window
        threadWindowManager?.closeAll()
        // Close and recreate the main window to reset conversation state
        mainWindow?.close()
        mainWindow = nil

        // 3. Persist the new assistant selection
        LockfileAssistant.setActiveAssistantId(assistant.assistantId)
        SentryDeviceInfo.updateAssistantTag(assistant.assistantId)
        // Clear stale org ID so the next bootstrap re-resolves it for the new assistant
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        SentryDeviceInfo.updateOrganizationTag(nil)
        // Clear stale actor token for the previous assistant
        actorTokenBootstrapTask?.cancel()
        actorTokenBootstrapTask = nil
        ActorTokenManager.deleteToken()

        // 4. For managed assistants, re-resolve the organization ID before
        //    connecting. The org ID was cleared in step 3; without it the
        //    health check's Vellum-Organization-Id header would be missing
        //    and the connection would fail.
        managedSwitchTask?.cancel()
        managedSwitchTask = nil
        if assistant.isManaged {
            let targetId = assistant.assistantId
            managedSwitchTask = Task {
                // Call resolveOrganizationId() directly — we only need the
                // org ID side effect here, not the full bootstrap (list +
                // hatch). Using ensureManagedAssistant() would trigger an
                // unnecessary listAssistants network call and could
                // overwrite connectedAssistantId via the 404/403 paths.
                do {
                    _ = try await ManagedAssistantBootstrapService.shared.resolveOrganizationId()
                } catch is CancellationError {
                    log.info("Managed switch to \(targetId, privacy: .public) cancelled")
                    return
                } catch {
                    log.error("Org resolution failed during switch: \(error.localizedDescription, privacy: .public)")
                    // If resolveOrganizationId() failed, connectedOrganizationId
                    // is still nil and the connection would fail for the same
                    // reason this fix exists. Only proceed if the org ID was
                    // actually resolved.
                    if UserDefaults.standard.string(forKey: "connectedOrganizationId") == nil {
                        log.error("Organization ID not resolved — aborting managed switch to \(targetId, privacy: .public)")
                        // The main window was already closed in step 2.
                        // Re-show it so the user isn't stranded without UI.
                        self.showMainWindow()
                        return
                    }
                }
                // resolveOrganizationId() doesn't touch connectedAssistantId,
                // but guard against a concurrent switch that cleared it.
                if LockfileAssistant.loadActiveAssistantId() == nil, !Task.isCancelled {
                    LockfileAssistant.setActiveAssistantId(targetId)
                }
                // Guard against a second switch that started while we were
                // awaiting the bootstrap — only finish if this task hasn't
                // been cancelled and this assistant is still the selected
                // target.
                guard !Task.isCancelled,
                      LockfileAssistant.loadActiveAssistantId() == targetId else {
                    log.info("Managed switch to \(targetId, privacy: .public) superseded — skipping finishSwitchAssistant")
                    return
                }
                self.finishSwitchAssistant(assistant)
            }
        } else {
            finishSwitchAssistant(assistant)
        }
    }

    /// Steps 5-6 of the switch sequence: reconfigure transport, resume
    /// credential bootstrap, sync keys, reload flags/avatar, and show UI.
    private func finishSwitchAssistant(_ assistant: LockfileAssistant) {
        // 5. Reconfigure transport and reconnect
        hasSetupDaemon = false
        setupGatewayConnectionManager()

        // 6. Resume credential bootstrap and show UI
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }
        // Reset before provisioning so a stale flag from a previous
        // bootstrap cycle doesn't cause awaitLocalBootstrapCompleted
        // to skip the wait. Mirrors the reset in proceedToApp().
        localBootstrapDidComplete = false
        ensureLocalAssistantApiKey()

        // Sync locally-stored API keys to the new assistant. The assistant may
        // have started without ANTHROPIC_API_KEY in its environment (e.g.
        // when the app was launched via Finder/open). Push keys from
        // UserDefaults so the assistant can initialize its LLM providers.
        syncApiKeysToAssistant(assistant)

        // Clear the UserDefaults feature-flag cache before reloading so
        // that stale cached values from the previous assistant do not
        // override the new assistant's remote/persisted flags.
        AssistantFeatureFlagResolver.clearCachedFlags()

        // Reload cached feature flags so SoundManager reads the new
        // assistant's resolved values instead of stale ones from the
        // previous assistant (the resolver reads instance-aware paths
        // that depend on connectedAssistantId).
        featureFlagStore.reloadFromDisk()

        // Reload avatar for the new assistant via the gateway.
        // Skip the reload when onboarding avatar traits are pending — the async
        // fetchTraitsViaHTTP inside reloadAvatar would find no traits on the
        // freshly-hatched assistant and clear the locally-saved character avatar.
        // syncOnboardingAvatarIfNeeded saves locally first, then syncs to the
        // assistant, which triggers its own reloadAvatar on success.
        if onboardingState?.hatchAvatarBodyShape != nil {
            syncOnboardingAvatarIfNeeded()
        } else {
            AvatarAppearanceManager.shared.reloadAvatar()
        }

        showMainWindow()
    }

    /// Push all locally-stored API keys to the assistant via the gateway.
    /// Launches a fire-and-forget Task; use ``syncApiKeysViaGateway()``
    /// when the caller needs to await completion.
    private func syncApiKeysToAssistant(_ assistant: LockfileAssistant) {
        Task {
            await syncApiKeysViaGateway()
        }
    }

    /// Push all locally-stored API keys to the assistant via GatewayHTTPClient.
    /// Awaitable so callers (e.g. the first-launch bootstrap) can ensure
    /// LLM provider keys are registered before sending the first message.
    func syncApiKeysViaGateway() async {
        guard let assistantId = LockfileAssistant.loadActiveAssistantId(),
              !assistantId.isEmpty else {
            log.warning("syncApiKeysViaGateway: no connected assistant, skipping key sync")
            return
        }

        // For local assistants the actor token may still be bootstrapping
        // (e.g. after performSwitchAssistant deletes the old token). Wait
        // for it before calling GatewayHTTPClient which reads it synchronously.
        let isManaged = LockfileAssistant.loadByName(assistantId)?.isManaged ?? false
        if !isManaged {
            guard let _ = await ActorTokenManager.waitForToken(timeout: 30) else {
                log.warning("syncApiKeysViaGateway: no actor token after 30s, skipping key sync")
                return
            }
        }

        for name in APIKeyManager.allSyncableProviders {
            guard let key = APIKeyManager.getKey(for: name), !key.isEmpty else { continue }
            let body: [String: Any] = ["type": "api_key", "name": name, "value": key]
            _ = try? await GatewayHTTPClient.post(path: "assistants/\(assistantId)/secrets", json: body, timeout: 5)
        }

        log.info("syncApiKeysViaGateway: pushed API keys for \(assistantId, privacy: .public)")
    }

    @objc func performRetire() {
        // Cancel any in-flight managed switch so it doesn't reconnect after retire.
        managedSwitchTask?.cancel()
        managedSwitchTask = nil
        Task { await performRetireAsync() }
    }

    /// Async retire implementation callable from SwiftUI so callers can
    /// await completion and dismiss their loading UI.
    ///
    /// Returns `true` if the retire completed (or the user chose to force-remove),
    /// `false` if the user cancelled after a failure.
    @discardableResult
    func performRetireAsync() async -> Bool {
        // Disconnect SSE and health checks *before* killing the
        // daemon/gateway. Otherwise the EventStreamClient reconnect loop
        // hits the gateway while the upstream daemon is already dead,
        // producing spurious "SSE connection failed with status 502" errors.
        connectionManager.disconnect()

        let client = AssistantManagementClient.create()
        let replacement: LockfileAssistant?
        do {
            replacement = try await client.retire()
        } catch {
            log.error("Retire failed: \(error.localizedDescription)")

            let alert = NSAlert()
            alert.messageText = "Failed to Retire Assistant"
            alert.informativeText = "\(error.localizedDescription)\n\nYou can force-remove the local configuration, but the assistant may still be running and will need to be cleaned up manually."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Force Remove")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() != .alertFirstButtonReturn {
                try? await connectionManager.connect()
                return false
            }
            // User chose "Force Remove" — the client delegates lockfile
            // cleanup to this shared protocol-extension method.
            replacement = await client.forceRemoveActiveAssistant()
        }

        finalizePostRetire(replacement: replacement)
        return true
    }

    /// Post-retire orchestration shared between the explicit retire flow and
    /// the remote-retire-detected flow: either switch to the replacement
    /// assistant or tear down the app and show onboarding.
    func finalizePostRetire(replacement: LockfileAssistant?) {
        if let replacement {
            performSwitchAssistant(to: replacement)
            return
        }

        // No assistants left — tear down fully and show onboarding
        AvatarAppearanceManager.shared.resetForDisconnect()
        OnboardingState.clearPersistedState()
        UserDefaults.standard.removeObject(forKey: "bootstrapState")
        SentryDeviceInfo.updateAssistantTag(nil)
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        SentryDeviceInfo.updateOrganizationTag(nil)
        SentryDeviceInfo.updateUserTag(nil)
        UserDefaults.standard.removeObject(forKey: "lastActivePanel")
        UserDefaults.standard.removeObject(forKey: "managedServiceModesInitialized")
        AssistantFeatureFlagResolver.clearCachedFlags()

        connectionManager.disconnect()
        actorTokenBootstrapTask?.cancel()
        actorTokenBootstrapTask = nil
        ActorTokenManager.deleteToken()

        threadWindowManager?.closeAll()
        mainWindow?.close()
        mainWindow = nil
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
        connectionManager.disconnect()
        UserDefaults.standard.removeObject(forKey: "user.profile")

        // Dev builds may have a custom bundle name (e.g. "Jarvis.app").
        // Rename the bundle back to "Vellum.app" and relaunch so the dock
        // label is correct on the onboarding screen. No-op for production
        // builds which always use "Vellum".
        if AppBundleRenamer.needsRename {
            AppBundleRenamer.renameAndRelaunch()
            // renameAndRelaunch() calls NSApp.terminate — execution does
            // not reach here. If the rename fails it returns false and we
            // fall through to showOnboarding().
        }

        showOnboarding()
    }

    /// Respond to `.managedAssistantRetiredRemotely`: the platform has no
    /// record of our active managed assistant. Force-remove its lockfile
    /// entry (platform deregistration is best-effort and will no-op on 404)
    /// and run the shared post-retire flow.
    func handleManagedAssistantRetiredRemotely() {
        guard let activeId = LockfileAssistant.loadActiveAssistantId() else {
            log.info("managedAssistantRetiredRemotely: no active assistant — ignoring")
            return
        }
        log.warning("Managed assistant '\(activeId, privacy: .public)' no longer exists on platform — cleaning up local state")
        Task { @MainActor in
            let client = AssistantManagementClient.create()
            let replacement = await client.forceRemoveActiveAssistant()
            finalizePostRetire(replacement: replacement)
        }
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
            let localAssistants = allAssistants.filter { !$0.isRemote || $0.isDocker || $0.isAppleContainer }

            // Disconnect SSE before retiring so the reconnect loop doesn't
            // hit a half-torn-down gateway and produce 502 errors.
            connectionManager.disconnect()

            // Retire each local assistant so cloud resources are cleaned up.
            for assistant in localAssistants {
                let client = AssistantManagementClient.create(for: assistant)
                do {
                    log.info("Retiring local assistant '\(assistant.assistantId, privacy: .public)' as part of uninstall")
                    try await client.retire(name: assistant.assistantId)
                } catch {
                    log.error("Failed to retire '\(assistant.assistantId, privacy: .public)' during uninstall: \(error.localizedDescription)")
                }
            }

            // Stop any remaining assistant processes.
            await vellumCli.stop()

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
