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
            let port = Int(launchEnvironment["RUNTIME_HTTP_PORT"] ?? "") ?? 7821
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
        // gateway can proxy iOS traffic to it.
        if let assistant, !assistant.isRemote {
            let port = Int(launchEnvironment["RUNTIME_HTTP_PORT"] ?? "") ?? 7821
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
            try await self.vellumCli.wake(name: name)
        }

        // Rebind the menu bar icon observer after transport reconfiguration
        // so connection status changes continue to update the icon.
        rebindConnectionStatusObserver()

        // Subscribe to SSE event stream for UI event routing.
        // Replaces individual onX callbacks — each event type is handled
        // in a single switch statement.
        startDaemonEventSubscription()


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
                    // Clear any stale startup error from a previous hatch attempt
                    // so a successful hatch doesn't leave a non-nil error in app state.
                    self.daemonStartupError = nil
                    do {
                        try await vellumCli.hatch(name: assistantName, daemonOnly: daemonOnly)
                    } catch let error as VellumCli.CLIError {
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
                                try await vellumCli.hatch(name: assistantName, daemonOnly: true)
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
                                try await vellumCli.hatch(name: assistantName, daemonOnly: true)
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
                            try await vellumCli.hatch(name: assistantName, daemonOnly: false)
                        } catch {
                            log.warning("Gateway restart failed — recovering daemon: \(error)")
                            // The full hatch may have torn down the daemon during
                            // cleanup; re-hatch daemon-only so the user isn't left
                            // with nothing.
                            do {
                                try await vellumCli.hatch(name: assistantName, daemonOnly: true)
                            } catch {
                                log.error("Daemon recovery after gateway failure also failed: \(error)")
                            }
                        }
                    }
                }
            }
            // Import guardian token from CLI file before connecting, so the
            // health check has valid credentials in the Keychain. On first
            // launch ensureActorCredentials() runs later in proceedToApp()
            // as a separate Task — this ensures the token is available in
            // time for connect()'s health check.
            if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
               !ActorTokenManager.hasToken {
                _ = GuardianTokenFileReader.importIfAvailable(assistantId: assistantId)
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

    // MARK: - SSE Event Subscription

    /// Subscribe to the daemon event stream and dispatch events to their handlers.
    /// Replaces the ~20 individual onX callback assignments that were previously set
    /// on DaemonClient. Each event type is handled in a single switch statement.
    private func startDaemonEventSubscription() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let stream = self.daemonClient.subscribe()
            for await message in stream {
                switch message {
                case .notificationIntent(let msg):
                    self.deliverNotificationIntent(msg)
                case .skillStateChanged:
                    self.refreshSkillsCache()
                case .openUrl(let msg):
                    guard let url = URL(string: msg.url) else { break }
                    let alert = NSAlert()
                    alert.messageText = "Open External Link?"
                    alert.informativeText = msg.url
                    alert.alertStyle = .informational
                    alert.addButton(withTitle: "Open in Browser")
                    alert.addButton(withTitle: "Cancel")
                    if alert.runModal() == .alertFirstButtonReturn {
                        NSWorkspace.shared.open(url)
                    }
                case .navigateSettings(let msg):
                    self.showSettingsTab(msg.tab)
                case .pairingApprovalRequest(let msg):
                    if self.pairingApprovalWindow == nil {
                        self.pairingApprovalWindow = PairingApprovalWindow()
                    }
                    self.pairingApprovalWindow?.show(
                        pairingRequestId: msg.pairingRequestId,
                        deviceName: msg.deviceName
                    )
                case .taskRunConversationCreated(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    self.mainWindow?.conversationManager.createTaskRunConversation(
                        conversationId: msg.conversationId,
                        workItemId: msg.workItemId,
                        title: msg.title
                    )
                case .scheduleConversationCreated(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    self.mainWindow?.conversationManager.createScheduleConversation(
                        conversationId: msg.conversationId,
                        scheduleJobId: msg.scheduleJobId,
                        title: msg.title
                    )
                case .notificationConversationCreated(let msg):
                    guard !self.isBootstrapping else { break }
                    self.handleNotificationConversationCreated(msg)
                case .documentEditorShow(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    self.mainWindow?.handleDocumentEditorShow(msg)
                case .documentEditorUpdate(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    self.mainWindow?.handleDocumentEditorUpdate(msg)
                case .documentSaveResponse(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    self.mainWindow?.handleDocumentSaveResponse(msg)
                case .documentLoadResponse(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    self.mainWindow?.handleDocumentLoadResponse(msg)
                case .recordingStart(let msg):
                    self.handleRecordingStart(msg)
                case .recordingStop(let msg):
                    Task {
                        _ = await self.recordingManager.stop(sessionId: msg.recordingId)
                        self.recordingHUDWindow?.dismiss()
                    }
                case .recordingPause(let msg):
                    self.handleRecordingPause(msg)
                case .recordingResume(let msg):
                    self.handleRecordingResume(msg)
                case .clientSettingsUpdate(let msg):
                    if msg.key == "ttsVoiceId" {
                        OpenAIVoiceService.overrideVoiceId = msg.value
                        UserDefaults.standard.set(msg.value, forKey: msg.key)
                    } else if msg.key == "voiceConversationTimeoutSeconds" {
                        let parsed = Int(msg.value)
                        if let parsed {
                            UserDefaults.standard.set(parsed, forKey: msg.key)
                        }
                        VoiceModeManager.conversationTimeoutOverride = parsed
                    } else {
                        UserDefaults.standard.set(msg.value, forKey: msg.key)
                    }
                    if msg.key == "activationKey" {
                        NotificationCenter.default.post(name: .activationKeyChanged, object: nil)
                    }
                case .identityChanged(let msg):
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
                case .avatarUpdated:
                    AvatarAppearanceManager.shared.reloadAvatar()
                // Host tool execution — run locally and post results back
                case .hostBashRequest(let msg):
                    HostToolExecutor.executeHostBashRequest(msg)
                case .hostFileRequest(let msg):
                    HostToolExecutor.executeHostFileRequest(msg)
                case .hostCuRequest(let msg):
                    let proxy = self.getOrCreateHostCuOverlay(conversationId: msg.conversationId, request: msg)
                    Task { @MainActor in
                        let result = await HostCuActionRunner.perform(msg, overlayProxy: proxy)
                        _ = await HostProxyClient().postCuResult(result)
                    }

                // Signing identity
                case .signBundlePayload(let msg):
                    self.handleSignBundlePayload(msg)
                case .getSigningIdentity(let msg):
                    self.handleGetSigningIdentity(msg)

                // Surface management (previously in setupSurfaceManager)
                case .uiSurfaceShow(let msg):
                    if msg.display != "inline" {
                        self.surfaceManager.userAppsDirectory = self.currentUserAppsDirectory()
                        self.surfaceManager.showSurface(msg)
                    }
                case .uiSurfaceUpdate(let msg):
                    self.surfaceManager.updateSurface(msg)
                case .uiSurfaceDismiss(let msg):
                    self.surfaceManager.dismissSurface(msg)
                case .uiSurfaceComplete(let msg):
                    self.surfaceManager.dismissSurface(UiSurfaceDismissMessage(
                        type: "ui_surface_dismiss",
                        conversationId: msg.conversationId ?? "",
                        surfaceId: msg.surfaceId
                    ))
                case .appFilesChanged(let msg):
                    self.refreshAppsCache()
                    for (surfaceId, appSurfaceId) in self.surfaceManager.surfaceAppIds {
                        guard appSurfaceId == msg.appId else { continue }
                        self.surfaceManager.surfaceCoordinators[surfaceId]?.webView?.reload()
                    }
                case .uiLayoutConfig(let msg):
                    self.mainWindow?.windowState.applyLayoutConfig(msg)

                // Tool confirmation (previously in setupToolConfirmationNotifications)
                case .confirmationRequest(let msg):
                    self.handleToolConfirmationRequest(msg)

                // Secret prompt (previously in setupSecretPromptManager)
                case .secretRequest(let msg):
                    self.secretPromptManager.showPrompt(msg)
                    SoundManager.shared.play(.needsInput)

                default:
                    break
                }
            }
        }
    }

    // MARK: - Signing Identity

    /// Handle a sign_bundle_payload request from the daemon.
    private func handleSignBundlePayload(_ msg: SignBundlePayloadMessage) {
        do {
            let payloadData = Data(msg.payload.utf8)
            let signature = try SigningIdentityManager.shared.sign(payloadData)
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            Task {
                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/sign-bundle-response",
                    json: [
                        "requestId": msg.requestId,
                        "signature": signature.base64EncodedString(),
                        "keyId": keyId,
                        "publicKey": publicKey.rawRepresentation.base64EncodedString()
                    ] as [String: Any]
                )
            }
        } catch {
            log.error("Failed to sign bundle payload: \(error.localizedDescription)")
        }
    }

    /// Handle a get_signing_identity request from the daemon.
    private func handleGetSigningIdentity(_ msg: GetSigningIdentityRequest) {
        do {
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            Task {
                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/signing-identity-response",
                    json: [
                        "requestId": msg.requestId,
                        "keyId": keyId,
                        "publicKey": publicKey.rawRepresentation.base64EncodedString()
                    ] as [String: Any]
                )
            }
        } catch {
            log.error("Failed to get signing identity: \(error.localizedDescription)")
        }
    }

    // MARK: - Privacy

    /// Synchronously migrates legacy privacy UserDefaults keys to their
    /// canonical equivalents. Must be called **before** Sentry initialization
    /// so that users who opted out via the old `collectUsageDataEnabled`
    /// master switch are respected from the very first SDK decision.
    ///
    /// This is the local-only (UserDefaults) portion of the migration.
    /// The daemon-sync portion still happens asynchronously in
    /// `syncPrivacyConfig()` after the daemon connects.
    static func migratePrivacyDefaults() {
        let legacyCollectUsageData = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool
        let canonicalCollectUsageData = UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
        let collectUsageData = canonicalCollectUsageData ?? legacyCollectUsageData

        let legacySendDiagnostics = UserDefaults.standard.object(forKey: "sendPerformanceReports") as? Bool
        let canonicalSendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
        let sendDiagnostics = canonicalSendDiagnostics ?? legacySendDiagnostics ?? collectUsageData

        // Write canonical keys so downstream reads (Sentry init, MetricKitManager)
        // see the migrated values without needing legacy fallback chains.
        if let collectUsageData {
            UserDefaults.standard.set(collectUsageData, forKey: "collectUsageData")
        }
        if let sendDiagnostics {
            UserDefaults.standard.set(sendDiagnostics, forKey: "sendDiagnostics")
        }

        // Clean up legacy keys
        UserDefaults.standard.removeObject(forKey: "collectUsageDataEnabled")
        UserDefaults.standard.removeObject(forKey: "sendPerformanceReports")
        UserDefaults.standard.removeObject(forKey: "collectUsageDataExplicitlySet")
    }

    /// Reads both privacy keys from UserDefaults, applies Sentry state based
    /// on sendDiagnostics, and syncs both keys to the daemon.
    ///
    /// Legacy key migration has already been performed by
    /// `migratePrivacyDefaults()` at launch, so this method only reads
    /// canonical keys.
    ///
    /// Only syncs a key to the daemon when a value is explicitly present in
    /// UserDefaults. When no local value exists we leave the daemon's
    /// persisted config untouched — defaulting to `true` and pushing that
    /// upstream would silently re-enable telemetry for users who previously
    /// opted out on a different machine or after a UserDefaults reset.
    func syncPrivacyConfig() {
        Task {
            let collectUsageData = UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
            let hasExplicitCollectUsageData = collectUsageData != nil

            let sendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
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
        }
    }

    // MARK: - Auto-Update

    func setupAutoUpdate() {
        guard !DevModeManager.shared.isDevMode else { return }

        updateManager.onWillInstallUpdate = { [weak self] in
            #if !DEBUG
            self?.keychainBroker?.stop()
            #endif
            self?.vellumCli.stop()
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
