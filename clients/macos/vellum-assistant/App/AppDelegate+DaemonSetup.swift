import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+DaemonSetup")

extension AppDelegate {

    // MARK: - Theme

    func applyThemePreference() {
        let pref = UserDefaults.standard.string(forKey: "themePreference") ?? "system"
        let appearance: NSAppearance?
        switch pref {
        case "light":
            appearance = NSAppearance(named: .aqua)
        case "dark":
            appearance = NSAppearance(named: .darkAqua)
        default:
            appearance = nil // follow system
        }

        NSApp.appearance = appearance
        for window in NSApp.windows {
            window.appearance = appearance
            window.invalidateShadow()
            window.contentView?.needsDisplay = true
        }
    }

    // MARK: - Lockfile & Transport

    /// Reads `connectedAssistantId` from UserDefaults, looks it up in the lockfile
    /// (falling back to the latest entry), and writes its config so the daemon connects
    /// to the correct assistant.
    ///
    /// Returns the loaded assistant for transport selection, or nil if none found.
    @discardableResult
    func loadAssistantFromLockfile() -> LockfileAssistant? {
        let storedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let assistant: LockfileAssistant?

        if let storedId, let found = LockfileAssistant.loadByName(storedId) {
            assistant = found
        } else {
            assistant = LockfileAssistant.loadLatest()
        }

        guard let assistant else { return nil }

        // If the assistant changed (e.g. user hatched a new one via CLI),
        // clear the stale actor token so ensureActorCredentials() triggers
        // a fresh bootstrap against the new daemon's JWT secret.
        if let storedId, storedId != assistant.assistantId, ActorTokenManager.hasToken {
            log.info("Assistant changed from \(storedId, privacy: .public) to \(assistant.assistantId, privacy: .public) — clearing stale actor token")
            actorTokenBootstrapTask?.cancel()
            actorTokenBootstrapTask = nil
            ActorTokenManager.deleteToken()
        }

        UserDefaults.standard.set(assistant.assistantId, forKey: "connectedAssistantId")
        assistant.writeToWorkspaceConfig()
        return assistant
    }

    /// Configure the daemon client's transport based on the lockfile assistant.
    /// Managed assistants (cloud == "vellum") use platform proxy with session token auth.
    /// Other remote assistants (cloud != "local") use HTTP+SSE via the gateway URL.
    /// Local assistants use HTTP+SSE via the daemon's runtime HTTP server.
    func configureDaemonTransport(for assistant: LockfileAssistant?) {
        isCurrentAssistantRemote = assistant?.isRemote ?? false
        isCurrentAssistantManaged = assistant?.isManaged ?? false
        let launchEnvironment = ProcessInfo.processInfo.environment

        // Managed assistant: use platform proxy URLs with session token auth.
        if let assistant, assistant.isManaged {
            let platformBaseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
            let metadata = TransportMetadata(
                routeMode: .platformAssistantProxy,
                authMode: .sessionToken,
                platformAssistantId: assistant.assistantId
            )
            let config = DaemonConfig(
                transport: .http(
                    baseURL: platformBaseURL,
                    bearerToken: nil,
                    conversationKey: assistant.assistantId
                ),
                transportMetadata: metadata
            )
            services.reconfigureDaemonClient(config: config)
            log.info("Configured managed transport for assistant \(assistant.assistantId) via platform at \(platformBaseURL, privacy: .public)")
            return
        }

        guard let assistant, assistant.isRemote, let runtimeUrl = assistant.runtimeUrl else {
            // Local assistant or no assistant — use HTTP transport to the local daemon.
            // Bearer token is nil; resolved lazily at connect time.
            let port = assistant?.resolvedDaemonPort(environment: launchEnvironment)
                ?? (Int(launchEnvironment["RUNTIME_HTTP_PORT"] ?? "") ?? 7821)
            let baseURL = "http://localhost:\(port)"
            let conversationKey = assistant?.assistantId ?? UUID().uuidString
            let instanceDir = assistant?.instanceDir
            let featureFlagToken = instanceDir.map { readFeatureFlagToken(environment: ["BASE_DATA_DIR": $0]) } ?? readFeatureFlagToken()
            let config = DaemonConfig(transport: .http(
                baseURL: baseURL,
                bearerToken: nil,
                conversationKey: conversationKey
            ), instanceDir: instanceDir, featureFlagToken: featureFlagToken)
            services.reconfigureDaemonClient(config: config)
            log.info("Configured local HTTP transport on port \(port)")
            return
        }

        let config = DaemonConfig(transport: .http(
            baseURL: runtimeUrl,
            bearerToken: assistant.bearerToken,
            conversationKey: assistant.assistantId
        ))

        // Reconfigure the daemon client's transport in place. This preserves
        // object identity so all long-lived holders keep a valid reference.
        services.reconfigureDaemonClient(config: config)

        log.info("Configured HTTP transport for remote assistant \(assistant.assistantId) at \(runtimeUrl, privacy: .public)")
    }

    // MARK: - Daemon Client Setup

    func setupDaemonClient(isFirstLaunch: Bool = false) {
        guard !hasSetupDaemon else { return }
        hasSetupDaemon = true

        let assistant = loadAssistantFromLockfile()
        let launchEnvironment = ProcessInfo.processInfo.environment

        // Ensure the daemon starts its runtime HTTP server so the
        // gateway can proxy iOS traffic to it. When a local assistant has a
        // lockfile-assigned daemon port, use that instead of the generic default.
        if let assistant, !assistant.isRemote {
            let port = assistant.resolvedDaemonPort(environment: launchEnvironment)
            setenv("RUNTIME_HTTP_PORT", String(port), 1)
        } else if launchEnvironment["RUNTIME_HTTP_PORT"] == nil {
            setenv("RUNTIME_HTTP_PORT", "7821", 0)
        }

        // Start the keychain broker before the daemon so it is listening
        // when the daemon process launches and reads the socket path.
        #if !DEBUG
        keychainBroker = KeychainBrokerServer()
        keychainBroker?.start()
        #endif

        configureDaemonTransport(for: assistant)

        // Set recovery credentials for automatic 401 re-bootstrap
        daemonClient.recoveryPlatform = "macos"
        daemonClient.recoveryDeviceId = PairingQRCodeSheet.computeHostId()

        // Rebind the menu bar icon observer after transport reconfiguration
        // so connection status changes continue to update the icon.
        rebindConnectionStatusObserver()

        daemonClient.onNotificationIntent = { [weak self] msg in
            self?.deliverNotificationIntent(msg)
        }

        // Handle open_bundle_response from the daemon
        daemonClient.onOpenBundleResponse = { [weak self] response in
            guard let self else { return }
            self.handleOpenBundleResponse(response)
        }

        // Refresh skills cache whenever skill state changes through any path
        daemonClient.onSkillStateChanged = { [weak self] _ in
            self?.refreshSkillsCache()
        }

        // Open URL: daemon -> Swift -> interstitial -> browser
        daemonClient.onOpenUrl = { msg in
            guard let url = URL(string: msg.url) else { return }
            let alert = NSAlert()
            alert.messageText = "Open External Link?"
            alert.informativeText = msg.url
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Open in Browser")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(url)
            }
        }

        daemonClient.onNavigateSettings = { [weak self] msg in
            Task { @MainActor in
                self?.showSettingsTab(msg.tab)
            }
        }

        daemonClient.onPairingApprovalRequest = { [weak self] msg in
            guard let self else { return }
            if self.pairingApprovalWindow == nil {
                self.pairingApprovalWindow = PairingApprovalWindow(daemonClient: self.daemonClient)
            }
            self.pairingApprovalWindow?.show(
                pairingRequestId: msg.pairingRequestId,
                deviceName: msg.deviceName
            )
        }

        // Automatically surface threads created by scheduled task runs so
        // the user sees them in the sidebar without restarting the app.
        daemonClient.onTaskRunThreadCreated = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.mainWindow?.threadManager.createTaskRunThread(
                conversationId: msg.conversationId,
                workItemId: msg.workItemId,
                title: msg.title
            )
        }

        // Schedule threads — created when the scheduler fires and creates a conversation.
        daemonClient.onScheduleThreadCreated = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.mainWindow?.threadManager.createScheduleThread(
                conversationId: msg.conversationId,
                scheduleJobId: msg.scheduleJobId,
                title: msg.title
            )
        }

        // Notification threads — created when the notification pipeline delivers
        // to the vellum channel with start_new_conversation strategy.
        daemonClient.onNotificationThreadCreated = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.handleNotificationThreadCreated(msg)
        }

        // Handle escalation: text_qa -> computer_use via computer_use_request_control
        daemonClient.onTaskRouted = { [weak self] routed in
            guard let self else { return }
            // Only handle escalation messages (those with escalatedFrom set)
            guard routed.escalatedFrom != nil,
                  routed.interactionType == "computer_use" else {
                log.debug("Ignoring non-escalation task_routed: type=\(routed.interactionType), escalatedFrom=\(routed.escalatedFrom ?? "nil")")
                return
            }
            self.handleEscalationToComputerUse(routed: routed)
        }

        // Forward dictation responses from the daemon to VoiceInputManager
        daemonClient.onDictationResponse = { [weak self] msg in
            self?.voiceInput?.onDictationResponse?(msg)
        }

        daemonClient.onDocumentEditorShow = { [weak self] msg in
            self?.mainWindow?.handleDocumentEditorShow(msg)
        }
        daemonClient.onDocumentEditorUpdate = { [weak self] msg in
            self?.mainWindow?.handleDocumentEditorUpdate(msg)
        }
        daemonClient.onDocumentSaveResponse = { [weak self] msg in
            self?.mainWindow?.handleDocumentSaveResponse(msg)
        }
        daemonClient.onDocumentLoadResponse = { [weak self] msg in
            self?.mainWindow?.handleDocumentLoadResponse(msg)
        }

        // Handle diagnostics export response — show a toast in the main window
        daemonClient.onDiagnosticsExportResponse = { [weak self] response in
            guard let self else { return }
            Task { @MainActor in
                if response.success, let filePath = response.filePath {
                    self.mainWindow?.windowState.showToast(
                        message: "Report exported successfully.",
                        style: .success,
                        primaryAction: VToastAction(label: "Reveal in Finder") {
                            NSWorkspace.shared.selectFile(filePath, inFileViewerRootedAtPath: "")
                        }
                    )
                } else {
                    let errorDetail = response.error ?? "Unknown error"
                    self.mainWindow?.windowState.showToast(
                        message: "Failed to export report: \(errorDetail)",
                        style: .error
                    )
                }
            }
        }

        // Handle recording_start from daemon: check permission, then start recording
        daemonClient.onRecordingStart = { [weak self] msg in
            guard let self else { return }
            self.handleRecordingStart(msg)
        }

        // Handle recording_stop from daemon
        daemonClient.onRecordingStop = { [weak self] msg in
            guard let self else { return }
            Task {
                _ = await self.recordingManager.stop(sessionId: msg.recordingId)
                self.recordingHUDWindow?.dismiss()
            }
        }

        // Handle recording_pause from daemon
        daemonClient.onRecordingPause = { [weak self] msg in
            guard let self else { return }
            self.handleRecordingPause(msg)
        }

        // Handle recording_resume from daemon
        daemonClient.onRecordingResume = { [weak self] msg in
            guard let self else { return }
            self.handleRecordingResume(msg)
        }

        // Handle client_settings_update from daemon: write to UserDefaults and post notification
        daemonClient.onClientSettingsUpdate = { msg in
            UserDefaults.standard.set(msg.value, forKey: msg.key)
            if msg.key == "activationKey" {
                NotificationCenter.default.post(name: .activationKeyChanged, object: nil)
            }
        }

        daemonClient.onIdentityChanged = { msg in
            DispatchQueue.main.async {
                NotificationCenter.default.post(
                    name: .identityChanged,
                    object: nil,
                    userInfo: [
                        "name": msg.name,
                        "role": msg.role,
                        "personality": msg.personality,
                        "emoji": msg.emoji,
                        "home": msg.home
                    ]
                )
            }
        }

        // Handle avatar_updated from daemon: reload the avatar image from disk
        daemonClient.onAvatarUpdated = { _ in
            Task { @MainActor in
                AvatarAppearanceManager.shared.reloadAvatar()
            }
        }

        // Restart DaemonClient connection when the health monitor relaunches
        // the daemon process so we don't wait for the backoff timer to expire.
        assistantCli.onDaemonRestarted = { [weak self] in
            guard let self else { return }
            Task {
                // Don't reset an in-progress connection attempt
                guard !self.daemonClient.isConnected, !self.daemonClient.isConnecting else { return }
                do {
                    try await self.daemonClient.connect()
                } catch {
                    log.error("Failed to reconnect to daemon after restart: \(error)")
                }
                if self.daemonClient.isConnected {
                    self.setupAmbientAgent()
                    self.refreshAppsCache()
                    self.refreshSkillsCache()
                    self.checkAndApplyPrivacyFlag()
                }
            }
        }

        Task {
            if !isCurrentAssistantRemote {
                // If the hatching step already started the gateway (e.g. `vellum-cli hatch --remote local`),
                // skip the CLI hatch to avoid spawning a duplicate gateway process.
                // Require BOTH lockfile and healthy gateway — a stale lockfile with an unhealthy
                // gateway falls through to the normal hatch path.
                let lockfileExists = self.lockfileHasAssistants()
                var gatewayHealthy = false
                if lockfileExists {
                    if isFirstLaunch {
                        // Retry window: gateway may still be starting from onboarding hatch
                        for _ in 0..<3 {
                            if await isGatewayHealthy() { gatewayHealthy = true; break }
                            try? await Task.sleep(nanoseconds: 1_000_000_000)
                        }
                    } else {
                        // Non-first-launch: single check, no retry delay
                        gatewayHealthy = await isGatewayHealthy()
                    }
                }

                if lockfileExists && gatewayHealthy {
                    log.info("Lockfile and gateway already present — skipping CLI hatch to avoid duplicate gateway")
                    assistantCli.startMonitoring()
                } else {
                    // On first launch post-onboarding, use daemonOnly: false so the CLI
                    // creates a lockfile entry. On subsequent launches, daemonOnly: true
                    // prevents duplicates.
                    let needsLockfileEntry = isFirstLaunch && !lockfileExists
                    let daemonOnly = !needsLockfileEntry
                    // Pass the selected assistant ID so the gateway starts
                    // with the correct default assistant (not a random name).
                    let assistantName = assistant?.assistantId
                    do {
                        try await assistantCli.hatch(name: assistantName, daemonOnly: daemonOnly)
                    } catch {
                        log.error("Failed to hatch assistant during daemon setup: \(error)")
                        if needsLockfileEntry {
                            log.info("Full hatch failed on first launch — retrying daemon-only as fallback")
                            try? await assistantCli.hatch(name: assistantName, daemonOnly: true)
                        }
                    }
                    if needsLockfileEntry {
                        _ = self.loadAssistantFromLockfile()
                    }
                    assistantCli.startMonitoring()
                }
            }
            // Skip connect if the bootstrap retry coordinator already connected
            // or has a connect in flight (hatch can take a long time; the
            // coordinator connects independently). Checking isConnecting
            // prevents tearing down the coordinator's in-flight HTTP connection
            // via disconnectInternal().
            if !daemonClient.isConnected && !daemonClient.isConnecting {
                do {
                    try await daemonClient.connect()
                } catch {
                    log.error("Failed to connect to daemon during setup: \(error)")
                }
            }
            // Once connected, start ambient agent if it was waiting for daemon
            if daemonClient.isConnected {
                setupAmbientAgent()
                refreshAppsCache()
                refreshSkillsCache()
                // Apply the privacy flag now that the gateway is reachable:
                // close Sentry if the user has opted out of usage data collection.
                checkAndApplyPrivacyFlag()
            }
        }
    }

    // MARK: - Privacy

    /// Queries the gateway feature-flags API for the collect-usage-data flag and,
    /// if the user has opted out, shuts down Sentry to stop future event capturing.
    /// Called after the daemon is first connected so the gateway is reachable.
    func checkAndApplyPrivacyFlag() {
        Task {
            do {
                let flags = try await daemonClient.getFeatureFlags()
                let collectUsageData = flags
                    .first(where: { $0.key == "feature_flags.collect-usage-data.enabled" })
                    .map { $0.enabled }
                    ?? true
                // Persist so MetricKitManager can check this flag synchronously
                // during the startup window on the next launch, regardless of
                // whether the user has visited the Privacy settings tab.
                UserDefaults.standard.set(collectUsageData, forKey: "collectUsageDataEnabled")
                if !collectUsageData {
                    // Route through sentrySerialQueue to prevent races with
                    // concurrent MetricKit captures or manual report sends.
                    MetricKitManager.closeSentry()
                }
            } catch {
                // Flag check is best-effort; Sentry stays active when the flag
                // cannot be read (e.g. gateway not yet ready on first boot).
                log.debug("Could not read privacy flag from gateway: \(error)")
            }
        }
    }

    // MARK: - Auto-Update

    func setupAutoUpdate() {
        updateManager.onWillInstallUpdate = { [weak self] in
            #if !DEBUG
            self?.keychainBroker?.stop()
            #endif
            self?.assistantCli.stop()
        }
        updateManager.startAutomaticChecks()
    }

    // MARK: - CLI Symlink

    /// Installs a `/usr/local/bin/vellum` symlink pointing to the bundled
    /// CLI binary so users can run `vellum` from their terminal.
    ///
    /// Skipped when dev mode is active (developers manage their own PATH)
    /// or when `vellum` already resolves to a different executable
    /// (avoids overwriting a developer's locally-built binary).
    func installCLISymlinkIfNeeded() {
        guard !services.settingsStore.isDevMode else { return }

        guard let execURL = Bundle.main.executableURL else { return }
        let cliBinary = execURL.deletingLastPathComponent()
            .appendingPathComponent("vellum-cli")
        guard FileManager.default.fileExists(atPath: cliBinary.path) else { return }

        let symlinkPath = "/usr/local/bin/vellum"
        let fm = FileManager.default

        // If the path exists, check whether it's our symlink or something else
        if let attrs = try? fm.attributesOfItem(atPath: symlinkPath),
           let type = attrs[.type] as? FileAttributeType {
            if type == .typeSymbolicLink {
                // Already a symlink — skip if it already points to our binary
                if let dest = try? fm.destinationOfSymbolicLink(atPath: symlinkPath),
                   dest == cliBinary.path {
                    return
                }
            } else {
                // Real file (not a symlink) — don't overwrite
                return
            }
        }

        // Check if `vellum` resolves elsewhere on PATH (developer's local build)
        let whichProc = Process()
        whichProc.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        whichProc.arguments = ["vellum"]
        let pipe = Pipe()
        whichProc.standardOutput = pipe
        whichProc.standardError = FileHandle.nullDevice
        do {
            try whichProc.run()
            whichProc.waitUntilExit()
            if whichProc.terminationStatus == 0 {
                let resolved = String(
                    data: pipe.fileHandleForReading.readDataToEndOfFile(),
                    encoding: .utf8
                )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !resolved.isEmpty && resolved != symlinkPath {
                    return
                }
            }
        } catch {
            // `which` failed to run — continue with symlink creation
        }

        // Create /usr/local/bin if needed, then create symlink
        do {
            let dir = (symlinkPath as NSString).deletingLastPathComponent
            if !fm.fileExists(atPath: dir) {
                try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            }
            // Remove stale symlink before creating a new one
            if (try? fm.attributesOfItem(atPath: symlinkPath)) != nil {
                try fm.removeItem(atPath: symlinkPath)
            }
            try fm.createSymbolicLink(atPath: symlinkPath, withDestinationPath: cliBinary.path)
            log.info("Installed CLI symlink: \(symlinkPath) → \(cliBinary.path)")
        } catch {
            log.warning("Could not install CLI symlink at \(symlinkPath): \(error.localizedDescription)")
        }
    }
}
