import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+ConnectionSetup")

extension AppDelegate {

    // MARK: - Theme

    func applyThemePreference() {
        let pref = UserDefaults.standard.string(forKey: "themePreference") ?? "system"
        VTheme.applyTheme(pref)
    }

    // MARK: - Lockfile & Transport

    /// Reads the active assistant from the lockfile (falling back to the latest
    /// entry), and writes its config so the client connects to the correct assistant.
    ///
    /// Returns the loaded assistant for transport selection, or nil if none found.
    /// Rejects managed assistants from a different platform environment (e.g.
    /// dev-platform assistants in a production build) and falls back to the
    /// first valid current-environment assistant.
    @discardableResult
    func loadAssistantFromLockfile() -> LockfileAssistant? {
        // Migration: fall back to UserDefaults for users upgrading from
        // the old version whose lockfile doesn't yet have activeAssistant.
        let storedId = LockfileAssistant.loadActiveAssistantId()
            ?? UserDefaults.standard.string(forKey: "connectedAssistantId")
        var assistant: LockfileAssistant?

        if let storedId, let found = LockfileAssistant.loadByName(storedId) {
            assistant = found
        } else {
            assistant = LockfileAssistant.loadLatest()
        }

        // If the resolved assistant is from a different platform environment,
        // clear the stale stored ID and fall back to any valid assistant.
        if let resolved = assistant, !resolved.isCurrentEnvironment {
            log.info("Stored assistant \(resolved.assistantId, privacy: .public) is cross-environment — searching for fallback")
            LockfileAssistant.setActiveAssistantId(nil)
            assistant = LockfileAssistant.loadAll().first { $0.isCurrentEnvironment }
        }

        guard let assistant else { return nil }

        // If the assistant changed (e.g. user hatched a new one via CLI),
        // clear the stale actor token so ensureActorCredentials() triggers
        // a fresh bootstrap against the new assistant's JWT secret.
        if let storedId, storedId != assistant.assistantId {
            log.info("Assistant changed from \(storedId, privacy: .public) to \(assistant.assistantId, privacy: .public) — clearing stale actor token")
            if ActorTokenManager.hasToken {
                actorTokenBootstrapTask?.cancel()
                actorTokenBootstrapTask = nil
                ActorTokenManager.deleteToken()
            }
            AssistantFeatureFlagResolver.clearCachedFlags()
            featureFlagStore.reloadFromDisk()
        }

        LockfileAssistant.setActiveAssistantId(assistant.assistantId)
        SentryDeviceInfo.updateAssistantTag(assistant.assistantId)
        return assistant
    }

    /// Configure the connection transport based on the lockfile assistant.
    /// Managed assistants (cloud == "vellum") use platform proxy with session token auth.
    /// Other remote assistants (cloud != "local") use HTTP+SSE via the gateway URL.
    /// Local assistants use HTTP+SSE via the assistant's runtime HTTP server.
    func configureDaemonTransport(for assistant: LockfileAssistant?) {
        isCurrentAssistantRemote = assistant?.isRemote ?? false
        isCurrentAssistantManaged = assistant?.isManaged ?? false
        isCurrentAssistantDocker = assistant?.isDocker ?? false

        // Managed assistant: platform proxy with session token auth.
        if let assistant, assistant.isManaged {
            services.reconfigureConnection(conversationKey: assistant.assistantId)
            log.info("Configured managed assistant \(assistant.assistantId, privacy: .public)")
            return
        }

        guard let assistant, assistant.isRemote else {
            // Local assistant or no assistant.
            let conversationKey = assistant?.assistantId ?? UUID().uuidString
            services.reconfigureConnection(conversationKey: conversationKey)
            log.info("Configured local assistant")
            return
        }

        // Remote assistant.
        services.reconfigureConnection(conversationKey: assistant.assistantId)
        log.info("Configured remote assistant \(assistant.assistantId, privacy: .public)")
    }

    // MARK: - Managed Reconnection

    /// Re-establish the gateway connection for a managed assistant after the
    /// user signs in from Settings. Resets `hasSetupDaemon` so the next call
    /// to `setupGatewayConnectionManager()` runs the full setup again.
    func reconnectManagedAssistant() {
        UserDefaults.standard.removeObject(forKey: "pendingManagedSwitchAssistantId")
        hasSetupDaemon = false
        setupGatewayConnectionManager()
    }

    // MARK: - Gateway Connection Setup

    func setupGatewayConnectionManager() {
        guard !hasSetupDaemon else { return }
        hasSetupDaemon = true

        let assistant = loadAssistantFromLockfile()

        configureDaemonTransport(for: assistant)

        // Set recovery credentials for automatic 401 re-bootstrap
        connectionManager.recoveryPlatform = "macos"
        connectionManager.recoveryDeviceId = PairingQRCodeSheet.computeHostId()

        // Auto-wake: if a connection attempt finds the assistant process dead,
        // wake it via the CLI before retrying.
        connectionManager.wakeHandler = { [weak self] in
            guard let self else { return }
            let name = LockfileAssistant.loadActiveAssistantId() ?? "default"
            log.info("Auto-wake: waking assistant '\(name, privacy: .public)' via CLI")
            try await self.vellumCli.wake(name: name)
        }

        // Post-Sparkle-update: run CLI finalize to broadcast complete + workspace commit.
        connectionManager.postSparkleUpdateHandler = { [weak self] name, fromVersion in
            guard let self else { return }
            try? await self.vellumCli.upgradeFinalize(name: name, fromVersion: fromVersion)
        }

        // Rebind the menu bar icon observer after transport reconfiguration
        // so connection status changes continue to update the icon.
        rebindConnectionStatusObserver()

        // Subscribe to SSE event stream for UI event routing.
        startEventSubscription()

        Task {
            // Import guardian token from CLI file before connecting, so the
            // health check has valid credentials in the credential store.
            if let assistantId = LockfileAssistant.loadActiveAssistantId(),
               !ActorTokenManager.hasToken {
                _ = GuardianTokenFileReader.importIfAvailable(assistantId: assistantId)
            }

            if !connectionManager.isConnected && !connectionManager.isConnecting {
                log.info("setupGatewayConnectionManager: calling connect()")
                do {
                    try await connectionManager.connect()
                    log.info("setupGatewayConnectionManager: connect() succeeded, isConnected=\(self.connectionManager.isConnected)")
                } catch {
                    log.error("Failed to connect during setup: \(error)")
                }
            } else {
                log.info("setupGatewayConnectionManager: skipping connect() — isConnected=\(self.connectionManager.isConnected), isConnecting=\(self.connectionManager.isConnecting)")
            }
            if connectionManager.isConnected {
                setupAmbientAgent()
                refreshAppsCache()
                refreshSkillsCache()
                syncPrivacyConfig()
                featureFlagStore.reloadFromGateway()
            }
        }
    }

    // MARK: - SSE Event Subscription

    /// Subscribe to the event stream and dispatch events to their handlers.
    /// Each event type is handled in a single switch statement.
    private func startEventSubscription() {
        eventSubscriptionTask?.cancel()
        eventSubscriptionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let stream = self.eventStreamClient.subscribe()
            for await message in stream {
                guard !Task.isCancelled else { break }
                switch message {
                case .notificationIntent(let msg):
                    self.deliverNotificationIntent(msg)
                case .skillStateChanged:
                    self.refreshSkillsCache()
                case .openUrl(let msg):
                    log.info("[open_url] Received open_url event: urlLength=\(msg.url.count), title=\(msg.title ?? "<none>")")
                    guard let url = URL(string: msg.url) else {
                        log.error("[open_url] Failed to parse URL from open_url event: \(msg.url.prefix(80))")
                        break
                    }
                    // Auto-open https URLs (trusted daemon origin); prompt for other schemes
                    if url.scheme == "https" {
                        log.info("[open_url] Opening https URL directly in default browser")
                        NSWorkspace.shared.open(url)
                    } else {
                        log.info("[open_url] Non-https scheme (\(url.scheme ?? "nil")), showing confirmation")
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
                case .openConversation(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    // If the conversation isn't in the sidebar yet (e.g. just created by a
                    // surface action with `_action: "launch_conversation"` that the daemon
                    // dispatched inline, spawning a fresh conversation and emitting
                    // open_conversation), stub a sidebar entry using the optional title so
                    // openConversation's trySelect retries find it.
                    // Tag the stub with source: "open_conversation" so it's distinguishable
                    // from true notification-flow stubs (which use source: "notification"
                    // and may drive urgency/alerting behaviors that don't apply here).
                    // This registration runs regardless of the focus flag so fan-out
                    // callers (focus: false) still get the conversation in the sidebar.
                    if let title = msg.title,
                       let conversationManager = self.mainWindow?.conversationManager,
                       !conversationManager.conversations.contains(where: { $0.conversationId == msg.conversationId }) {
                        conversationManager.createNotificationConversation(
                            conversationId: msg.conversationId,
                            title: title,
                            sourceEventName: "open_conversation",
                            groupId: nil,
                            source: "open_conversation"
                        )
                    }
                    // Switch focus only when the emitter did not explicitly opt out
                    // (msg.focus != false). Absent (nil) defaults to switching, which
                    // preserves existing single-target behavior.
                    if shouldFocusForOpenConversation(msg) {
                        self.openConversation(conversationId: msg.conversationId, anchorMessageId: msg.anchorMessageId)
                    }
                case .navigateSettings(let msg):
                    self.showSettingsTab(msg.tab)
                case .showPlatformLogin:
                    self.showPlatformLogin()
                case .platformDisconnected:
                    self.performLogout()
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
                case .heartbeatConversationCreated(let msg):
                    guard !self.isBootstrapping else { break }
                    self.ensureMainWindowExists()
                    self.mainWindow?.conversationManager.createHeartbeatConversation(
                        conversationId: msg.conversationId,
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
                    if msg.key == "voiceConversationTimeoutSeconds" {
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
                    // Notify observers when the global TTS provider changes so
                    // voice mode and other consumers can pick up the new provider.
                    if msg.key == "ttsProvider" {
                        NotificationCenter.default.post(name: .configChanged, object: nil)
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
                case .avatarUpdated(let msg):
                    AvatarAppearanceManager.shared.reloadAvatar(avatarPath: msg.avatarPath)
                case .soundsConfigUpdated:
                    SoundManager.shared.reloadConfig()
                case .configChanged:
                    NotificationCenter.default.post(name: .configChanged, object: nil)
                case .featureFlagsChanged:
                    self.featureFlagStore.reloadFromGateway()
                // Host tool execution — run locally and post results back
                case .hostBashRequest(let msg):
                    HostToolExecutor.executeHostBashRequest(msg)
                case .hostFileRequest(let msg):
                    HostToolExecutor.executeHostFileRequest(msg)
                case .hostCuRequest(let msg):
                    let proxy = self.getOrCreateHostCuOverlay(conversationId: msg.conversationId, request: msg)
                    let task = Task { @MainActor in
                        defer { self.inFlightCuTasks.removeValue(forKey: msg.requestId) }

                        guard !Task.isCancelled else {
                            HostCuActionRunner.clearSession(msg.conversationId)
                            return
                        }
                        let result = await HostCuActionRunner.perform(msg, overlayProxy: proxy)

                        guard !Task.isCancelled else {
                            HostCuActionRunner.clearSession(msg.conversationId)
                            return
                        }

                        // Suppress stale POST if cancelled
                        if HostToolExecutor.isCancelledAndConsume(msg.requestId) {
                            HostCuActionRunner.clearSession(msg.conversationId)
                            log.debug("Host CU result suppressed (cancelled) — requestId=\(msg.requestId, privacy: .public)")
                            return
                        }
                        _ = await HostProxyClient().postCuResult(result)
                    }
                    self.inFlightCuTasks[msg.requestId] = task

                case .hostBashCancel(let msg):
                    HostToolExecutor.cancelHostBashRequest(msg.requestId)
                case .hostFileCancel(let msg):
                    HostToolExecutor.cancelHostFileRequest(msg.requestId)
                case .hostCuCancel(let msg):
                    self.cancelHostCuRequest(msg.requestId)

                // Signing identity
                case .signBundlePayload(let msg):
                    self.handleSignBundlePayload(msg)
                case .getSigningIdentity(let msg):
                    self.handleGetSigningIdentity(msg)

                // Surface management (previously in setupSurfaceManager)
                case .uiSurfaceShow(let msg):
                    if msg.display != "inline" {
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
                    // WebView reload is handled by the separate ui_surface_update
                    // message which triggers updateNSView → reloadGeneration →
                    // loadHTMLString with fresh compiled HTML. Calling
                    // webView.reload() here would replay stale inline HTML for
                    // surfaces loaded via loadHTMLString (isInlineFallback),
                    // racing with the correct ui_surface_update path.
                    _ = msg
                case .uiLayoutConfig(let msg):
                    self.mainWindow?.windowState.applyLayoutConfig(msg)

                // Tool confirmation (previously in setupToolConfirmationNotifications)
                case .confirmationRequest(let msg):
                    self.handleToolConfirmationRequest(msg)

                // Secret prompt (previously in setupSecretPromptManager)
                case .secretRequest(let msg):
                    self.secretPromptManager.showPrompt(msg)
                    SoundManager.shared.play(.needsInput)

                case .conversationError(let msg):
                    if msg.code == .authenticationRequired && self.isCurrentAssistantManaged {
                        log.info("Received authenticationRequired error for managed assistant — showing reauth screen")
                        // Only set pending if not already set (preserve user's intended switch target)
                        if UserDefaults.standard.string(forKey: "pendingManagedSwitchAssistantId") == nil,
                           let assistantId = LockfileAssistant.loadActiveAssistantId() {
                            UserDefaults.standard.set(assistantId, forKey: "pendingManagedSwitchAssistantId")
                        }
                        self.showAuthWindow()
                    }

                default:
                    break
                }
            }
        }
    }

    // MARK: - Host CU Cancel

    /// Cancel an in-flight host CU request: mark it cancelled, cancel the
    /// Swift Task, and dismiss the overlay.
    func cancelHostCuRequest(_ requestId: String) {
        HostToolExecutor.markCancelled(requestId)
        if let task = inFlightCuTasks.removeValue(forKey: requestId) {
            task.cancel()
        }
        // Always dismiss — the task may have already completed and removed
        // itself from inFlightCuTasks, but the overlay can still be visible.
        dismissHostCuOverlay()
        log.info("Cancelling host CU — requestId=\(requestId, privacy: .public)")
    }

    // MARK: - Signing Identity

    /// Handle a sign_bundle_payload request from the assistant.
    private func handleSignBundlePayload(_ msg: SignBundlePayloadMessage) {
        Task {
            do {
                let payloadData = Data(msg.payload.utf8)
                let signature = try await SigningIdentityManager.shared.sign(payloadData)
                let keyId = try await SigningIdentityManager.shared.getKeyId()
                let publicKey = try await SigningIdentityManager.shared.getPublicKey()

                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/sign-bundle-response",
                    json: [
                        "requestId": msg.requestId,
                        "signature": signature.base64EncodedString(),
                        "keyId": keyId,
                        "publicKey": publicKey.rawRepresentation.base64EncodedString()
                    ] as [String: Any]
                )
            } catch {
                log.error("Failed to sign bundle payload: \(error.localizedDescription)")
                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/sign-bundle-response",
                    json: [
                        "requestId": msg.requestId,
                        "error": error.localizedDescription
                    ] as [String: Any]
                )
            }
        }
    }

    /// Handle a get_signing_identity request from the assistant.
    private func handleGetSigningIdentity(_ msg: GetSigningIdentityRequest) {
        Task {
            do {
                let keyId = try await SigningIdentityManager.shared.getKeyId()
                let publicKey = try await SigningIdentityManager.shared.getPublicKey()

                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/signing-identity-response",
                    json: [
                        "requestId": msg.requestId,
                        "keyId": keyId,
                        "publicKey": publicKey.rawRepresentation.base64EncodedString()
                    ] as [String: Any]
                )
            } catch {
                log.error("Failed to get signing identity: \(error.localizedDescription)")
                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/signing-identity-response",
                    json: [
                        "requestId": msg.requestId,
                        "error": error.localizedDescription
                    ] as [String: Any]
                )
            }
        }
    }

    // MARK: - Legacy Migration

    /// One-time migration: copies the legacy `connectedAssistantId` value from
    /// UserDefaults into the lockfile's `activeAssistant` field, then removes
    /// the UserDefaults key. This ensures users upgrading from a version that
    /// stored the active assistant in UserDefaults don't silently switch to a
    /// different assistant on first launch.
    ///
    /// Safe to call multiple times — exits immediately when:
    /// - The lockfile already has an `activeAssistant` value (migration not needed)
    /// - UserDefaults has no `connectedAssistantId` (nothing to migrate)
    static func migrateConnectedAssistantIdToLockfile() {
        // If the lockfile already has an active assistant, the migration is
        // either already done or the user set it via CLI — nothing to do.
        if LockfileAssistant.loadActiveAssistantId() != nil {
            UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
            return
        }

        // Check for legacy UserDefaults value
        guard let legacyId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
              !legacyId.isEmpty else {
            return
        }

        // Verify the assistant exists in the lockfile before writing
        if LockfileAssistant.loadByName(legacyId) != nil {
            LockfileAssistant.setActiveAssistantId(legacyId)
            log.info("Migrated connectedAssistantId '\(legacyId, privacy: .public)' from UserDefaults to lockfile")
        } else {
            log.warning("Legacy connectedAssistantId '\(legacyId, privacy: .public)' not found in lockfile — skipping migration")
        }

        // Always clean up the legacy key
        UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
    }

    // MARK: - Privacy

    /// Synchronously migrates legacy privacy UserDefaults keys to their
    /// canonical equivalents. Must be called **before** Sentry initialization
    /// so that users who opted out via the old `collectUsageDataEnabled`
    /// master switch are respected from the very first SDK decision.
    ///
    /// This is the local-only (UserDefaults) portion of the migration.
    /// The assistant-sync portion still happens asynchronously in
    /// `syncPrivacyConfig()` after the assistant connects.
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
    /// on sendDiagnostics, and syncs both keys to the assistant.
    ///
    /// Legacy key migration has already been performed by
    /// `migratePrivacyDefaults()` at launch, so this method only reads
    /// canonical keys.
    ///
    /// Only syncs a key to the assistant when a value is explicitly present in
    /// UserDefaults. When no local value exists we leave the assistant's
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

            // Best-effort sync to assistant config — only include keys that the
            // user has explicitly set locally to avoid overwriting remote opt-outs.
            let syncCollectUsageData = hasExplicitCollectUsageData ? collectUsageData : nil
            let syncSendDiagnostics = hasExplicitSendDiagnostics ? sendDiagnostics : nil
            if syncCollectUsageData != nil || syncSendDiagnostics != nil {
                try? await FeatureFlagClient().setPrivacyConfig(
                    collectUsageData: syncCollectUsageData,
                    sendDiagnostics: syncSendDiagnostics,
                    llmRequestLogRetentionMs: nil
                )
            }

            let tosAccepted = UserDefaults.standard.bool(forKey: "tosAccepted")
            log.info("ToS accepted: \(tosAccepted, privacy: .public)")
        }
    }

    // MARK: - Auto-Update

    func setupAutoUpdate() {
        guard !DevModeManager.shared.isDevMode else { return }

        updateManager.onWillInstallUpdate = { [weak self] in
            guard let self else { return }
            let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
            let targetVersion = self.updateManager.pendingUpdateVersion ?? "unknown"
            let name = LockfileAssistant.loadActiveAssistantId() ?? ""

            // Single CLI call replaces 8 steps of pre-update orchestration
            let backupPath = try? await self.vellumCli.upgradePrepare(
                name: name,
                targetVersion: targetVersion
            )

            // Store backup path for "Restore Pre-Update Data" button
            if let backupPath {
                UserDefaults.standard.set(backupPath, forKey: "preUpdateBackupPath")
            }

            // Cache current version for post-update detection
            UserDefaults.standard.set(currentVersion, forKey: "preUpdateVersion")

            // Stop daemon before app replacement
            await self.vellumCli.stop()
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
    /// Installs CLI symlinks if needed. Designed to run off the main thread
    /// (Process.waitUntilExit internally blocks on a DispatchSemaphore).
    nonisolated static func installCLISymlinkIfNeeded(isDevMode: Bool) {
        guard !isDevMode else { return }

        guard let execURL = Bundle.main.executableURL else { return }
        let macosDir = execURL.deletingLastPathComponent()

        let cliBinary = macosDir.appendingPathComponent("vellum-cli")
        if FileManager.default.fileExists(atPath: cliBinary.path) {
            installSymlink(commandName: "vellum", target: cliBinary.path)
        }

    }

    /// Creates a symlink at /usr/local/bin/<commandName> pointing to the
    /// given target binary, falling back to ~/.local/bin if /usr/local/bin
    /// is not writable. Skips creation when the destination already exists
    /// as a regular file, already points to the correct target, or the
    /// command resolves elsewhere on PATH (developer's local build).
    private nonisolated static func installSymlink(commandName: String, target: String) {
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
