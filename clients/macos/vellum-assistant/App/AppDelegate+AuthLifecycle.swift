import AppKit
import Combine
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+AuthLifecycle")

enum ManagedSwitchAuthenticationGate {
    static func shouldPromptForLogin(
        assistant: LockfileAssistant,
        isAuthenticated: Bool,
        managedAuthenticationAlreadyVerified: Bool
    ) -> Bool {
        assistant.isManaged
            && !isAuthenticated
            && !managedAuthenticationAlreadyVerified
    }
}

// MARK: - Auth lifecycle: login, logout, restart, retire, switch assistant

extension AppDelegate {

    func startAuthenticatedFlow() {
        Task {
            await authManager.checkSession()
            SentryDeviceInfo.updateUserTag(authManager.currentUser?.id)
            let isAuthed = authManager.isAuthenticated
            log.info("[authFlow] isAuthenticated=\(isAuthed)")
            if isAuthed {
                // Delegate the post-auth routing decision to
                // ReturningUserRouter so this call site and ReauthView
                // share one source of truth.
                //
                // First pull the platform's authoritative list of managed
                // assistants and reconcile the local lockfile against it —
                // this is what lets a fresh sign-in on a new install (or a
                // new env-scoped lockfile path) discover assistants the
                // account already owns. When the platform fetch fails we
                // fall back to the lockfile-only fast path.
                let router = ReturningUserRouter()
                let decision: ReturningUserRouter.RoutingDecision
                if let landscape = try? await router.fetchLandscape(),
                   landscape.platformWasConsulted {
                    let result = LockfileReconciler.reconcile(
                        platformAssistants: landscape.platformAssistants
                    )
                    if result.didChange {
                        log.info(
                            "[authFlow] lockfile reconciled: +\(result.added.count) -\(result.removed.count)"
                        )
                    }
                    // Re-evaluate from the freshly reconciled lockfile so
                    // the routing decision sees any added or removed
                    // managed entries.
                    decision = router.decideFast() ?? .showHostingPicker
                } else {
                    decision = router.decideFast() ?? .showHostingPicker
                }

                switch decision {
                case .autoConnect:
                    log.info("[authFlow] router → autoConnect → proceedToApp()")
                    proceedToApp()
                case .showHostingPicker:
                    log.info("[authFlow] router → showHostingPicker")
                    showAuthWindow()
                case .showAssistantPicker:
                    log.info("[authFlow] router → showAssistantPicker")
                    showAuthWindow()
                }
            } else {
                // Not authenticated: only non-managed assistants may bypass
                // the auth window. Local/remote assistants run independently
                // of the platform auth session, so the app can open in a
                // logged-out state and the user can sign in from Settings >
                // General. Managed (platform-hosted) assistants always
                // require platform authentication — presence of locally
                // stored provider API keys does NOT substitute for a
                // platform session.
                // Migration: fall back to UserDefaults for users upgrading
                // from the old version whose lockfile doesn't yet have
                // activeAssistant.
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

    func showAuthWindow(
        reusingWindow existingWindow: NSWindow? = nil,
        forceOnboarding: Bool = false
    ) {
        if let existing = authWindow, !forceOnboarding {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hasManagedAssistants = !forceOnboarding
            && LockfileAssistant.loadAll().contains { $0.isManaged && $0.isCurrentEnvironment }
        let authView: AnyView

        if hasManagedAssistants {
            // Returning managed user — show clean sign-in, not full onboarding
            authView = AnyView(ReauthView(
                authManager: authManager,
                onComplete: { [weak self] in
                    self?.proceedToApp()
                },
                onNeedsHostingPicker: { [weak self] in
                    self?.showAuthWindow(forceOnboarding: true)
                },
                onNeedsAssistantPicker: { [weak self] landscape in
                    self?.showAssistantPicker(landscape: landscape)
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

        // When forcing the onboarding picker after re-auth, reuse the
        // current authWindow so the view swaps in-place rather than
        // closing and re-opening a window.
        let windowToReuse = existingWindow ?? (forceOnboarding ? authWindow : nil)

        let window: NSWindow
        if let windowToReuse {
            window = windowToReuse
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

    /// Shared post-login path for sign-ins that happen while the app is
    /// already running on a local or remote assistant. It mirrors the
    /// re-auth router instead of blindly provisioning the current assistant,
    /// so platform assistants hatched elsewhere are offered alongside local
    /// lockfile entries.
    func handlePlatformLoginSucceeded() {
        Task { @MainActor [weak self] in
            await self?.handlePlatformLoginSucceededAsync()
        }
    }

    private func handlePlatformLoginSucceededAsync() async {
        guard authManager.isAuthenticated else { return }

        do {
            _ = try await AuthService.shared.resolveOrganizationId()
        } catch is CancellationError {
            return
        } catch {
            log.warning("Post-login organization resolution failed — continuing with current assistant: \(error.localizedDescription, privacy: .public)")
        }

        let router = ReturningUserRouter()
        do {
            let landscape = try await router.fetchLandscape()
            switch router.decide(for: landscape) {
            case .showAssistantPicker:
                log.info("Post-login router → showAssistantPicker")
                showAssistantPicker(landscape: landscape)
                return
            case .showHostingPicker:
                log.info("Post-login router → showHostingPicker")
                showAuthWindow(forceOnboarding: true)
                return
            case .autoConnect:
                break
            }
        } catch is CancellationError {
            return
        } catch {
            log.warning("Post-login assistant routing failed — continuing with current assistant: \(error.localizedDescription, privacy: .public)")
        }

        completePostLoginForCurrentAssistant()
    }

    private func completePostLoginForCurrentAssistant() {
        // Re-bootstrap actor credentials first so the actor token is available
        // when local assistant API key provisioning waits for it. Managed
        // assistants derive identity from the platform session.
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }

        localBootstrapDidComplete = false
        ensureLocalAssistantApiKey()

        if isCurrentAssistantManaged {
            reconnectManagedAssistant()
        }
    }

    /// Show the assistant picker in the auth window. Builds picker items
    /// from both the lockfile and the platform list (via the landscape) so
    /// platform-only assistants (hatched on another device) are included.
    private func showAssistantPicker(landscape: ReturningUserRouter.AssistantLandscape) {
        let platformById = Dictionary(
            landscape.platformAssistants.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let items = AssistantPickerItem.from(landscape: landscape)

        let pickerView = AssistantPickerView(
            assistants: items,
            onConnect: { [weak self] assistantId in
                guard let self else { return false }
                guard let target = AssistantPickerSelectionResolver.resolveLockfileAssistant(
                    assistantId: assistantId,
                    platformAssistants: platformById
                ) else {
                    let alert = NSAlert()
                    alert.messageText = "Could not connect to assistant"
                    alert.informativeText = "The selected assistant could not be saved locally. Please try again."
                    alert.alertStyle = .warning
                    alert.runModal()
                    return false
                }

                // Fire-and-forget for managed assistants: tell the platform
                // this is the active assistant. Failure is non-fatal — the
                // lockfile is the client source of truth for which assistant
                // to connect to.
                if target.isManaged,
                   let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
                    Task {
                        do {
                            try await AuthService.shared.activateAssistant(
                                id: target.assistantId,
                                organizationId: orgId
                            )
                        } catch {
                            log.warning("Failed to activate assistant on platform: \(error.localizedDescription)")
                        }
                    }
                }

                self.authWindow?.close()
                self.authWindow = nil

                if self.hasSetupApp {
                    if LockfileAssistant.loadActiveAssistantId() == target.assistantId {
                        self.completePostLoginForCurrentAssistant()
                        self.showMainWindow()
                    } else {
                        self.performSwitchAssistant(
                            to: target,
                            managedAuthenticationAlreadyVerified: target.isManaged
                        )
                    }
                } else {
                    LockfileAssistant.setActiveAssistantId(target.assistantId)
                    SentryDeviceInfo.updateAssistantTag(target.assistantId)
                    self.proceedToApp()
                }
                return true
            },
            onSignOut: { [weak self] in
                Task {
                    await self?.authManager.logout()
                    self?.showAuthWindow()
                }
            }
        )

        if let window = authWindow {
            window.contentViewController = NSHostingController(rootView: pickerView)
            // Ensure the window matches the standard auth size — it may
            // have been resized or the content swap can leave it undersized.
            window.contentMinSize = NSSize(width: 420, height: 580)
            if let visibleFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame {
                let targetWidth: CGFloat = 460
                let targetHeight: CGFloat = 620
                let x = visibleFrame.midX - targetWidth / 2
                let y = visibleFrame.midY - targetHeight / 2
                window.setFrame(NSRect(x: x, y: y, width: targetWidth, height: targetHeight), display: true, animate: true)
            }
            NSApp.activateAsDockAppIfNeeded()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 620),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.contentViewController = NSHostingController(rootView: pickerView)
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
            window.backgroundColor = NSColor(VColor.surfaceOverlay)
            window.isReleasedWhenClosed = false
            window.contentMinSize = NSSize(width: 420, height: 580)

            let targetWidth: CGFloat = 460
            let targetHeight: CGFloat = 620
            if let visibleFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame {
                let x = visibleFrame.midX - targetWidth / 2
                let y = visibleFrame.midY - targetHeight / 2
                window.setFrame(NSRect(x: x, y: y, width: targetWidth, height: targetHeight), display: true)
            } else {
                window.setContentSize(NSSize(width: targetWidth, height: targetHeight))
                window.center()
            }

            authWindow = window
            NSApp.activateAsDockAppIfNeeded()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc func performRestart() {
        // Terminate-first relaunch: spawn a detached shell watcher that
        // waits for our PID to exit, then launches a fresh app instance
        // via `open`.  Only one instance is ever alive, so we don't need
        // a sentinel file or a single-instance-guard exception.
        //
        // Apple provides no first-party "restart self" API; every
        // self-relaunch in the macOS ecosystem (Sparkle, Electron, etc.)
        // uses a helper-process variant of this pattern.  `AppBundleRenamer`
        // already uses a richer version of the same pattern in this codebase.
        //
        // Daemon / gateway shutdown runs through the normal terminate path
        // (`applicationShouldTerminate` → `vellumCli.stop()`), so the new
        // instance comes up to a cleanly-freed daemon state.
        //
        // SSE + health checks are disconnected here (before the normal
        // shutdown path starts) to prevent `autoWakeIfAssistantDied()` from
        // waking the daemon right back up while `cli.stop()` is killing it.
        // Same ordering as `performRetireAsync()`.
        connectionManager.disconnect()

        let pid = ProcessInfo.processInfo.processIdentifier
        // Escape for safe interpolation into a bash single-quoted string —
        // single quotes prevent `$`, `` ` ``, and `\` expansion that double
        // quotes would allow.  Same pattern as `AppBundleRenamer.shellEscape`.
        let escapedBundlePath = Bundle.main.bundlePath
            .replacingOccurrences(of: "'", with: "'\\''")

        let watcher = Process()
        watcher.executableURL = URL(fileURLWithPath: "/bin/sh")
        watcher.arguments = [
            "-c",
            """
            # Wait up to 30 seconds for our PID to exit.  Must exceed
            # `VellumCli.stopTimeout` (15s) plus AppKit teardown headroom,
            # otherwise a slow daemon/gateway shutdown causes the watcher
            # to abort before the old instance has actually exited —
            # terminating the app without relaunching it.  If terminate
            # is cancelled (e.g. an unsaved-changes sheet returns
            # `.terminateCancel`) we must not loop forever.
            for _ in $(seq 1 300); do
                kill -0 \(pid) 2>/dev/null || break
                sleep 0.1
            done
            # If still alive, abort rather than launching a second instance
            # that would race the existing one and be killed by the
            # single-instance guard.
            if kill -0 \(pid) 2>/dev/null; then
                exit 0
            fi
            open '\(escapedBundlePath)'
            """
        ]
        watcher.standardOutput = FileHandle.nullDevice
        watcher.standardError = FileHandle.nullDevice
        watcher.qualityOfService = .utility

        do {
            try watcher.run()
        } catch {
            log.error("Restart failed — could not spawn relaunch watcher: \(error.localizedDescription)")
            // Reconnect so the app doesn't stay in a disconnected state
            // after a failed relaunch attempt.  (Same pattern as
            // performRetireAsync()'s cancel path.)
            Task { @MainActor [weak self] in
                try? await self?.connectionManager.connect()
            }
            return
        }

        log.info("Restart: relaunch watcher spawned (pid \(watcher.processIdentifier)), terminating self")
        NSApp.terminate(nil)
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
                connectionStatusTask?.cancel()
                connectionStatusTask = nil
                statusDotLayer?.removeAllAnimations()
                statusDotLayer?.removeFromSuperlayer()
                statusDotLayer = nil

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
                if let bootstrapError = error as? LocalBootstrapError,
                   case .existingRegistrationConflict(let existing, let organizationId) = bootstrapError {
                    let didRetire = await self.presentExistingRegistrationConflict(
                        existing: existing,
                        organizationId: organizationId
                    )
                    if didRetire {
                        log.info("Retired conflicting assistant — retrying local bootstrap")
                        self.ensureLocalAssistantApiKey()
                        return
                    }
                    log.info("User cancelled conflict retire; abandoning local bootstrap")
                    self.localBootstrapDidComplete = true
                    SentryDeviceInfo.updateOrganizationTag(UserDefaults.standard.string(forKey: "connectedOrganizationId"))
                    NotificationCenter.default.post(name: .localBootstrapCompleted, object: nil)
                    return
                }

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

    /// Returns true iff the user confirmed and the retire succeeded (caller should retry bootstrap).
    @MainActor
    private func presentExistingRegistrationConflict(
        existing: PlatformAssistant,
        organizationId: String
    ) async -> Bool {
        let label = existing.name ?? existing.id
        let alert = NSAlert()
        alert.messageText = "Another Assistant Is Already Registered"
        alert.informativeText = "\"\(label)\" is currently registered to your account. Retire it to register this assistant in its place."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Retire & Continue")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else {
            return false
        }
        do {
            try await AuthService.shared.retireSelfHostedLocalAssistant(
                platformAssistantId: existing.id,
                organizationId: organizationId
            )
            return true
        } catch {
            log.error("Failed to retire conflicting assistant: \(error.localizedDescription)")
            let failureAlert = NSAlert()
            failureAlert.messageText = "Could Not Retire Assistant"
            failureAlert.informativeText = error.localizedDescription
            failureAlert.alertStyle = .warning
            failureAlert.addButton(withTitle: "OK")
            failureAlert.runModal()
            return false
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
    func performSwitchAssistant(
        to assistant: LockfileAssistant,
        managedAuthenticationAlreadyVerified: Bool = false
    ) {
        // If switching to a managed assistant while logged out, prompt login first.
        if ManagedSwitchAuthenticationGate.shouldPromptForLogin(
            assistant: assistant,
            isAuthenticated: authManager.isAuthenticated,
            managedAuthenticationAlreadyVerified: managedAuthenticationAlreadyVerified
        ) {
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
            _ = try? await GatewayHTTPClient.post(path: "secrets", json: body, timeout: 5)
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
        // Apple Guideline 5.1.2(i): AI Data Sharing consent must be re-collected
        // on the next onboarding pass after a full retire. ToS is intentionally
        // sticky and not cleared (matches web behavior).
        UserDefaults.standard.removeObject(forKey: "aiDataConsent")
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
        connectionStatusTask?.cancel()
        connectionStatusTask = nil
        statusDotLayer?.removeAllAnimations()
        statusDotLayer?.removeFromSuperlayer()
        statusDotLayer = nil

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
