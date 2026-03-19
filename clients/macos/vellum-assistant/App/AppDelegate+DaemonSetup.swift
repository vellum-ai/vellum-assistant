import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+DaemonSetup")

extension AppDelegate {

    // MARK: - Theme

    func applyThemePreference() {
        let pref = UserDefaults.standard.string(forKey: "themePreference") ?? "system"
        VThemeToggle.applyTheme(pref)
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
        SentryDeviceInfo.updateAssistantTag(assistant.assistantId)
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
            log.info("Configured managed transport for assistant \(assistant.assistantId, privacy: .public) via platform at \(platformBaseURL, privacy: .public)")
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
            let config = DaemonConfig(transport: .http(
                baseURL: baseURL,
                bearerToken: nil,
                conversationKey: conversationKey
            ), instanceDir: instanceDir)
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

        log.info("Configured HTTP transport for remote assistant \(assistant.assistantId, privacy: .public) at \(runtimeUrl, privacy: .public)")
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
        } else {
            setenv("RUNTIME_HTTP_PORT", "7821", 1)
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

        // Auto-wake: if a connection attempt finds the daemon process dead,
        // wake it via the CLI before retrying.
        daemonClient.wakeHandler = { [weak self] in
            guard let self else { return }
            let name = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? "default"
            log.info("Auto-wake: waking assistant '\(name, privacy: .public)' via CLI")
            try await self.assistantCli.wake(name: name)
        }

        // Rebind the menu bar icon observer after transport reconfiguration
        // so connection status changes continue to update the icon.
        rebindConnectionStatusObserver()

        daemonClient.onNotificationIntent = { [weak self] msg in
            self?.deliverNotificationIntent(msg)
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
                self.pairingApprovalWindow = PairingApprovalWindow()
            }
            self.pairingApprovalWindow?.show(
                pairingRequestId: msg.pairingRequestId,
                deviceName: msg.deviceName
            )
        }

        // Automatically surface conversations created by scheduled task runs so
        // the user sees them in the sidebar without restarting the app.
        daemonClient.onTaskRunConversationCreated = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.ensureMainWindowExists()
            self.mainWindow?.conversationManager.createTaskRunConversation(
                conversationId: msg.conversationId,
                workItemId: msg.workItemId,
                title: msg.title
            )
        }

        // Schedule conversations — created when the scheduler fires and creates a conversation.
        daemonClient.onScheduleConversationCreated = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.ensureMainWindowExists()
            self.mainWindow?.conversationManager.createScheduleConversation(
                conversationId: msg.conversationId,
                scheduleJobId: msg.scheduleJobId,
                title: msg.title
            )
        }

        // Notification conversations — created when the notification pipeline delivers
        // to the vellum channel with start_new_conversation strategy.
        daemonClient.onNotificationConversationCreated = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.handleNotificationConversationCreated(msg)
        }

        daemonClient.onDocumentEditorShow = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.ensureMainWindowExists()
            self.mainWindow?.handleDocumentEditorShow(msg)
        }
        daemonClient.onDocumentEditorUpdate = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.ensureMainWindowExists()
            self.mainWindow?.handleDocumentEditorUpdate(msg)
        }
        daemonClient.onDocumentSaveResponse = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.ensureMainWindowExists()
            self.mainWindow?.handleDocumentSaveResponse(msg)
        }
        daemonClient.onDocumentLoadResponse = { [weak self] msg in
            guard let self, !self.isBootstrapping else { return }
            self.ensureMainWindowExists()
            self.mainWindow?.handleDocumentLoadResponse(msg)
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

        // Handle client_settings_update from daemon: route specific keys to their
        // override properties; write all other keys to UserDefaults as before.
        daemonClient.onClientSettingsUpdate = { msg in
            if msg.key == "ttsVoiceId" {
                OpenAIVoiceService.overrideVoiceId = msg.value
            } else if msg.key == "voiceConversationTimeoutSeconds" {
                VoiceModeManager.conversationTimeoutOverride = Int(msg.value)
            } else {
                UserDefaults.standard.set(msg.value, forKey: msg.key)
            }
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

        // Register host CU handler so incoming host_cu_request messages
        // execute locally (verify -> execute -> observe -> post result).
        // The overlay provider lazily creates a session overlay on the first
        // host_cu_request for each conversation.
        HostCuExecutor.register(on: daemonClient) { [weak self] conversationId, request in
            guard let self else { return nil }
            return self.getOrCreateHostCuOverlay(conversationId: conversationId, request: request)
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
                } else {
                    // On first launch post-onboarding, use daemonOnly: false so the CLI
                    // creates a lockfile entry AND starts the gateway. On subsequent
                    // launches, daemonOnly: true prevents duplicates — gateway restart
                    // is handled separately below to avoid tearing down the daemon on
                    // transient gateway failures.
                    let needsLockfileEntry = isFirstLaunch && !lockfileExists
                    let daemonOnly = !needsLockfileEntry
                    // Pass the selected assistant ID so the gateway starts
                    // with the correct default assistant (not a random name).
                    let assistantName = assistant?.assistantId
                    do {
                        try await assistantCli.hatch(name: assistantName, daemonOnly: daemonOnly)
                    } catch let error as AssistantCli.CLIError {
                        switch error {
                        case .daemonStartupFailed(let startupError):
                            log.error("Daemon startup failed [\(startupError.category, privacy: .public)]: \(startupError.message, privacy: .private)")
                            self.daemonStartupError = startupError
                            MetricKitManager.reportDaemonStartupFailure(startupError)
                        default:
                            log.error("Failed to hatch assistant during daemon setup: \(error)")
                        }
                        if needsLockfileEntry {
                            log.info("Full hatch failed on first launch — retrying daemon-only as fallback")
                            do {
                                try await assistantCli.hatch(name: assistantName, daemonOnly: true)
                                self.daemonStartupError = nil
                            } catch {
                                log.error("Fallback daemon-only hatch also failed: \(error)")
                            }
                        }
                    } catch {
                        log.error("Failed to hatch assistant during daemon setup: \(error)")
                        if needsLockfileEntry {
                            log.info("Full hatch failed on first launch — retrying daemon-only as fallback")
                            do {
                                try await assistantCli.hatch(name: assistantName, daemonOnly: true)
                                self.daemonStartupError = nil
                            } catch {
                                log.error("Fallback daemon-only hatch also failed: \(error)")
                            }
                        }
                    }
                    if needsLockfileEntry {
                        _ = self.loadAssistantFromLockfile()
                    }

                    // Gateway died between app launches — attempt to restart it
                    // separately from the daemon. If gateway startup fails, recover
                    // the daemon so the user can still interact (just without gateway).
                    if !needsLockfileEntry && !gatewayHealthy {
                        log.info("Gateway unhealthy — attempting separate restart")
                        do {
                            try await assistantCli.hatch(name: assistantName, daemonOnly: false)
                        } catch {
                            log.warning("Gateway restart failed — recovering daemon: \(error)")
                            // The full hatch may have torn down the daemon during
                            // cleanup; re-hatch daemon-only so the user isn't left
                            // with nothing.
                            do {
                                try await assistantCli.hatch(name: assistantName, daemonOnly: true)
                            } catch {
                                log.error("Daemon recovery after gateway failure also failed: \(error)")
                            }
                        }
                    }
                }
            }
            // Skip connect if the bootstrap retry coordinator already connected
            // or has a connect in flight (hatch can take a long time; the
            // coordinator connects independently). Checking isConnecting
            // prevents tearing down the coordinator's in-flight HTTP connection
            // via disconnectInternal().
            if !daemonClient.isConnected && !daemonClient.isConnecting {
                log.info("setupDaemonClient: calling connect()")
                do {
                    try await daemonClient.connect()
                    log.info("setupDaemonClient: connect() succeeded, isConnected=\(self.daemonClient.isConnected)")
                } catch {
                    log.error("Failed to connect to daemon during setup: \(error)")
                }
            } else {
                log.info("setupDaemonClient: skipping connect() — isConnected=\(self.daemonClient.isConnected), isConnecting=\(self.daemonClient.isConnecting)")
            }
            // Once connected, start ambient agent if it was waiting for daemon
            if daemonClient.isConnected {
                setupAmbientAgent()
                refreshAppsCache()
                refreshSkillsCache()
                // Sync privacy config now that the gateway is reachable:
                // close Sentry if diagnostics are disabled, and sync both
                // keys to the daemon.
                syncPrivacyConfig()
            }
        }
    }

    // MARK: - Privacy

    /// Reads both privacy keys from UserDefaults (with legacy fallbacks),
    /// applies Sentry state based on sendDiagnostics, syncs both keys to
    /// the daemon, and cleans up legacy UserDefaults keys.
    ///
    /// Only syncs a key to the daemon when a value is explicitly present in
    /// UserDefaults (including legacy keys). When no local value exists we
    /// leave the daemon's persisted config untouched — defaulting to `true`
    /// and pushing that upstream would silently re-enable telemetry for
    /// users who previously opted out on a different machine or after a
    /// UserDefaults reset.
    func syncPrivacyConfig() {
        Task {
            // Read with legacy fallbacks for first launch after upgrade.
            // Keep track of whether a value was explicitly set vs defaulted,
            // so we only sync explicitly-set values to the daemon.
            let legacyCollectUsageData = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool
            let canonicalCollectUsageData = UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
            let collectUsageData = canonicalCollectUsageData ?? legacyCollectUsageData
            let hasExplicitCollectUsageData = collectUsageData != nil

            let canonicalSendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
            // Fall back to legacy collectUsageData keys so users who opted
            // out via the old master switch keep Sentry disabled.
            let sendDiagnostics = canonicalSendDiagnostics ?? collectUsageData
            let hasExplicitSendDiagnostics = sendDiagnostics != nil

            // Apply Sentry state based on sendDiagnostics (default true when absent)
            if !(sendDiagnostics ?? true) {
                MetricKitManager.closeSentry()
            }

            // Best-effort sync to daemon config — only include keys that the
            // user has explicitly set locally to avoid overwriting remote opt-outs.
            let syncCollectUsageData = hasExplicitCollectUsageData ? collectUsageData : nil
            let syncSendDiagnostics = hasExplicitSendDiagnostics ? sendDiagnostics : nil
            if syncCollectUsageData != nil || syncSendDiagnostics != nil {
                try? await FeatureFlagClient().setPrivacyConfig(collectUsageData: syncCollectUsageData, sendDiagnostics: syncSendDiagnostics)
            }

            let tosAccepted = UserDefaults.standard.bool(forKey: "tosAccepted")
            log.info("ToS accepted: \(tosAccepted, privacy: .public)")

            // Clean up legacy keys and write canonical ones
            UserDefaults.standard.removeObject(forKey: "collectUsageDataEnabled")
            UserDefaults.standard.removeObject(forKey: "sendPerformanceReports")
            UserDefaults.standard.removeObject(forKey: "collectUsageDataExplicitlySet")
            if let collectUsageData {
                UserDefaults.standard.set(collectUsageData, forKey: "collectUsageData")
            }
            if let sendDiagnostics {
                UserDefaults.standard.set(sendDiagnostics, forKey: "sendDiagnostics")
            }
        }
    }

    // MARK: - Auto-Update

    func setupAutoUpdate() {
        guard !DevModeManager.shared.isDevMode else { return }

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
        guard !DevModeManager.shared.isDevMode else { return }

        guard let execURL = Bundle.main.executableURL else { return }
        let macosDir = execURL.deletingLastPathComponent()

        let cliBinary = macosDir.appendingPathComponent("vellum-cli")
        if FileManager.default.fileExists(atPath: cliBinary.path) {
            installSymlink(commandName: "vellum", target: cliBinary.path)
        }

        let assistantBinary = macosDir.appendingPathComponent("vellum-assistant")
        if FileManager.default.fileExists(atPath: assistantBinary.path) {
            installSymlink(commandName: "assistant", target: assistantBinary.path)
        }
    }

    /// Creates a symlink at /usr/local/bin/<commandName> pointing to the
    /// given target binary, falling back to ~/.local/bin if /usr/local/bin
    /// is not writable. Skips creation when the destination already exists
    /// as a regular file, already points to the correct target, or the
    /// command resolves elsewhere on PATH (developer's local build).
    private func installSymlink(commandName: String, target: String) {
        let fm = FileManager.default

        // Candidate directories in priority order: /usr/local/bin (system-wide),
        // then ~/.local/bin (user-writable, no sudo needed).
        let localBin = fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin").path
        let candidateDirs = ["/usr/local/bin", localBin]

        // Check if the command already resolves on PATH to something other than
        // our candidate paths (developer's local build) — skip entirely.
        let candidatePaths = Set(candidateDirs.map { "\($0)/\(commandName)" })
        let whichProc = Process()
        whichProc.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        whichProc.arguments = [commandName]
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
                if !resolved.isEmpty && !candidatePaths.contains(resolved) {
                    return
                }
            }
        } catch {
            // `which` failed to run — continue with symlink creation
        }

        for dir in candidateDirs {
            let symlinkPath = "\(dir)/\(commandName)"

            // If the path exists, check whether it's our symlink or something else
            if let attrs = try? fm.attributesOfItem(atPath: symlinkPath),
               let type = attrs[.type] as? FileAttributeType {
                if type == .typeSymbolicLink {
                    // Already a symlink — skip if it already points to our binary
                    if let dest = try? fm.destinationOfSymbolicLink(atPath: symlinkPath),
                       dest == target {
                        return
                    }
                } else {
                    // Real file (not a symlink) — try next candidate
                    continue
                }
            }

            // Create the directory if needed, then create the symlink
            do {
                if !fm.fileExists(atPath: dir) {
                    try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
                }
                // Remove stale symlink before creating a new one
                if (try? fm.attributesOfItem(atPath: symlinkPath)) != nil {
                    try fm.removeItem(atPath: symlinkPath)
                }
                try fm.createSymbolicLink(atPath: symlinkPath, withDestinationPath: target)
                log.info("Installed CLI symlink: \(symlinkPath) → \(target)")
                return
            } catch {
                log.info("Could not install CLI symlink at \(symlinkPath): \(error.localizedDescription) — trying next candidate")
            }
        }

        log.warning("Could not install CLI symlink for \(commandName) in any candidate directory")
    }
}
