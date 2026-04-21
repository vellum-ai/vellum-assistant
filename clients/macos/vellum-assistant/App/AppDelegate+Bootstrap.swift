import AppKit
import Combine
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate")

/// Tracks the first-launch bootstrap sequence so the app can resume
/// from the correct phase after a restart mid-bootstrap.
/// Raw values are persisted in UserDefaults under `"bootstrapState"`.
enum BootstrapState: String {
    case pendingDaemon = "pendingDaemon"
    case pendingWakeupSend = "pendingWakeupSend"
    case pendingFirstReply = "pendingFirstReply"
    case timedOut = "timedOut"
    case complete = "complete"
}

// MARK: - Bootstrap State Machine

extension AppDelegate {

    /// Persists the current bootstrap state to UserDefaults.
    func persistBootstrapState() {
        UserDefaults.standard.set(bootstrapState.rawValue, forKey: "bootstrapState")
    }

    /// Transitions to a new bootstrap state, persists it, and emits stage timing logs.
    func transitionBootstrap(to newState: BootstrapState) {
        log.info("Bootstrap state: \(self.bootstrapState.rawValue, privacy: .public) → \(newState.rawValue, privacy: .public)")
        bootstrapState = newState
        persistBootstrapState()

        // Emit stage timing when a start timestamp is available.
        if let start = bootstrapStartTime {
            let elapsedMs = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
            switch newState {
            case .pendingWakeupSend:
                log.info("bootstrap.daemon_ready_ms: \(elapsedMs)")
            case .pendingFirstReply:
                log.info("bootstrap.wakeup_sent_ms: \(elapsedMs)")
            case .complete:
                log.info("bootstrap.first_reply_ms: \(elapsedMs)")
            case .pendingDaemon, .timedOut:
                break
            }
        }
    }

    /// Waits for `connectionManager.isConnected` to become `true`, or until
    /// the timeout expires — whichever comes first.
    ///
    /// Does NOT call `connect()` itself — that is the sole responsibility of
    /// `setupGatewayConnectionManager()`.
    func awaitDaemonReady(timeout: TimeInterval) async -> Bool {
        log.info("Waiting for assistant to become ready (timeout: \(timeout)s)")

        if connectionManager.isConnected {
            log.info("Assistant is connected")
            return true
        }

        let connected = await withTaskGroup(of: Bool.self, returning: Bool.self) { group in
            group.addTask { @MainActor [connectionManager = self.connectionManager] in
                for await isConnected in connectionManager.isConnectedStream where isConnected {
                    return true
                }
                return false
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }

        if connected {
            log.info("Assistant is connected")
        } else {
            log.warning("Assistant connection timed out after \(timeout)s")
        }
        return connected || connectionManager.isConnected
    }

    /// Waits for the local bootstrap to complete (`.localBootstrapCompleted` notification)
    /// or until the timeout expires. This ensures managed-proxy credentials are provisioned
    /// before the wake-up greeting triggers an LLM call.
    func awaitLocalBootstrapCompleted(timeout: TimeInterval) async {
        if localBootstrapDidComplete {
            log.info("Local bootstrap already completed — skipping wait")
            return
        }
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                for await _ in NotificationCenter.default.notifications(named: .localBootstrapCompleted) {
                    return
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard !Task.isCancelled else { return }
                log.warning("Local bootstrap did not complete within \(timeout)s — proceeding with wake-up")
            }
            await group.next()
            group.cancelAll()
        }
    }

    /// Sends the wake-up greeting. If the assistant is disconnected, waits for
    /// reconnection before proceeding. Since `showMainWindow` always creates
    /// the window (via `ensureMainWindowExists`), there is no need for a
    /// retry loop — a simple guard suffices.
    func performRetriableWakeUpSend() async {
        guard !Task.isCancelled else { return }

        // If assistant disconnected, wait for reconnection before trying
        if !connectionManager.isConnected {
            log.warning("Assistant disconnected during wake-up send — waiting for reconnection")
            let reconnected = await awaitDaemonReady(timeout: 15)
            if !reconnected {
                log.warning("Assistant did not reconnect — showing timeout screen")
                transitionBootstrap(to: .timedOut)
                showMainWindow(isFirstLaunch: true)
                debugStateWriter.start(appDelegate: self)
                return
            }
        }

        let greeting = wakeUpGreeting()
        showMainWindow(initialMessage: greeting, isFirstLaunch: true)

        // showMainWindow always creates mainWindow, but guard defensively.
        guard let main = mainWindow else {
            log.error("MainWindow not created after showMainWindow — cannot send wake-up")
            return
        }

        log.info("MainWindow created — deferring pendingFirstReply until wake-up message is dispatched")
        main.onWakeUpSent = { [weak self] in
            guard let self else { return }
            log.info("Wake-up greeting actually sent — transitioning to pendingFirstReply")
            self.transitionBootstrap(to: .pendingFirstReply)
            self.wireBootstrapFirstReplyCallback()
        }
        debugStateWriter.start(appDelegate: self)
    }

    /// Wires `onFirstAssistantReply` on the active ChatViewModel so bootstrap
    /// transitions to `.complete` when the assistant's first reply arrives.
    func wireBootstrapFirstReplyCallback() {
        guard let viewModel = mainWindow?.activeViewModel else {
            log.warning("No active ChatViewModel to wire first-reply callback — completing bootstrap immediately")
            transitionBootstrap(to: .complete)
            return
        }
        viewModel.onFirstAssistantReply = { [weak self] _ in
            self?.transitionBootstrap(to: .complete)
        }
    }

    // MARK: - Actor Token Credentials

    /// Schedules proactive credential refresh when the access token is near expiry.
    /// On first launch (no actor token), falls back to bootstrap for initial issuance.
    func ensureActorCredentials() {
        actorTokenBootstrapTask?.cancel()

        // Re-bootstrap on instance switch — remove previous closure-based observer
        // using the opaque token (removeObserver(self) doesn't work for closure observers).
        if let prev = instanceChangeObserver {
            NotificationCenter.default.removeObserver(prev)
        }
        instanceChangeObserver = NotificationCenter.default.addObserver(forName: .daemonInstanceChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            log.info("Assistant instance changed — re-running credential bootstrap")
            Task { @MainActor in
                self.ensureActorCredentials()
            }
        }

        actorTokenBootstrapTask = Task { [weak self] in
            guard let self else { return }

            // Bootstrap if we have no actor token, or if the refresh token
            // is expired (meaning the existing token can never be refreshed).
            // Without this check, a stale-but-present token causes the app to
            // skip bootstrap and enter the proactive refresh loop, which fails
            // terminally — leaving the user stuck with no way to re-authenticate.
            if !ActorTokenManager.hasToken || ActorTokenManager.isRefreshTokenExpired {
                if ActorTokenManager.isRefreshTokenExpired {
                    log.info("Refresh token expired — clearing stale credentials for re-bootstrap")
                    ActorTokenManager.deleteAllCredentials()
                }
                await self.performInitialBootstrap()
            }

            // Run proactive refresh loop
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000) // Check every 5 minutes
                guard !Task.isCancelled else { return }

                if ActorTokenManager.needsProactiveRefresh {
                    guard self.connectionManager.isConnected else { continue }

                    let result = await TokenRefreshCoordinator.shared.refreshIfNeeded(
                        platform: "macos",
                        deviceId: PairingQRCodeSheet.computeHostId()
                    )

                    switch result {
                    case .success:
                        log.info("Proactive token refresh succeeded")
                    case .terminalError(let reason):
                        log.error("Proactive token refresh failed terminally: \(reason)")
                    case .transientError:
                        log.warning("Proactive token refresh encountered transient error — will retry")
                    }
                }
            }
        }
    }

    /// Clears any stored actor-token credentials and re-runs the initial
    /// bootstrap flow. Unlike `ensureActorCredentials()`, which short-circuits
    /// when a stored token is already present, this method deliberately wipes
    /// the existing credential first so `performInitialBootstrap()` is forced
    /// to re-provision from scratch. Intended as a recovery primitive for
    /// stale/invalid credentials (see `GatewayConnectionManager.attemptRePair()`).
    ///
    /// In Docker/cloud hatches, the CLI-persisted `guardian-token.json` on
    /// disk can still contain the same revoked token that produced the auth
    /// failures. `performInitialBootstrap()` imports that file ahead of any
    /// HTTP path, so without deleting it we would silently re-arm the bad
    /// credential and the re-pair would "succeed" only to fall right back
    /// into 401s. Delete the file for remote hatches (Docker/cloud/managed),
    /// where the CLI or launcher will re-provision and rewrite the file,
    /// so the bootstrap is forced down a genuine reprovision path.
    ///
    /// For local/bare-metal assistants the on-disk token is the only
    /// recovery artifact — nothing is guaranteed to rewrite it — so preserve
    /// it. Bootstrap will still skip the (now-wiped) in-memory credentials
    /// and re-import from the file, which is the intended local fallback.
    ///
    /// If the delete is attempted but fails (e.g. filesystem permissions),
    /// the stale file would otherwise be re-imported by
    /// `performInitialBootstrap()`, defeating the fix. In that case pass
    /// `skipFileImport: true` so the bootstrap ignores the file entirely
    /// and drives the HTTP reprovision path.
    func forceReBootstrap() async {
        log.info("forceReBootstrap: clearing stored credentials and re-running bootstrap")
        ActorTokenManager.deleteAllCredentials()

        var skipFileImport = false
        if let assistantId = LockfileAssistant.loadActiveAssistantId() {
            let assistant = LockfileAssistant.loadByName(assistantId)
            let isRemoteHatch = assistant?.isRemote ?? false
            if isRemoteHatch {
                let deleted = GuardianTokenFileReader.deleteTokenFile(assistantId: assistantId)
                if !deleted {
                    log.warning("forceReBootstrap: failed to delete stale guardian token file — skipping file import to avoid re-arming the revoked token")
                    skipFileImport = true
                }
            } else {
                log.info("forceReBootstrap: local/bare-metal hatch — preserving guardian token file as the only recovery artifact")
                // Clear the guardian-init lock so /v1/guardian/init can succeed
                // again. Without this, the HTTP fallback in performInitialBootstrap
                // is permanently 403'd on bare-metal after the first hatch.
                let cleared = await GuardianClient().resetBootstrap()
                if !cleared {
                    log.warning("forceReBootstrap: reset-bootstrap failed — HTTP fallback may still be locked out")
                }
            }
        }
        await performInitialBootstrap(skipFileImport: skipFileImport)
    }

    /// Performs the initial actor token bootstrap, reactively waiting for a
    /// gateway connection before each attempt. Called only when no actor token
    /// exists (first launch or after credential wipe).
    ///
    /// Before hitting the network, checks whether the CLI already persisted a
    /// guardian token to disk (e.g. during a Docker or cloud hatch). If found,
    /// imports it directly and skips the HTTP bootstrap entirely.
    ///
    /// `skipFileImport`: when `true`, bypass the guardian-token.json import
    /// entirely and jump straight to the HTTP fallback. Used by
    /// `forceReBootstrap()` when a stale file could not be deleted — leaving
    /// the import path enabled in that case would silently re-arm the revoked
    /// token the re-bootstrap is meant to discard.
    func performInitialBootstrap(skipFileImport: Bool = false) async {
        guard let assistantId = LockfileAssistant.loadActiveAssistantId() else { return }

        if !skipFileImport {
            // Try importing a guardian token that was already written to disk
            // (e.g. by the CLI during hatch or by AppleContainersLauncher).
            if GuardianTokenFileReader.importIfAvailable(assistantId: assistantId) {
                log.info("Imported guardian token from file — skipping HTTP bootstrap")
                return
            }

            // The token file doesn't exist yet — the launcher/CLI may still be
            // writing it. Poll for up to ~60s before falling back to HTTP bootstrap.
            let maxAttempts = 30
            let delay: UInt64 = 2_000_000_000 // 2 seconds per poll
            for attempt in 1...maxAttempts {
                guard !Task.isCancelled else { return }
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled else { return }

                if GuardianTokenFileReader.importIfAvailable(assistantId: assistantId) {
                    log.info("Imported guardian token from file after \(attempt) poll(s)")
                    return
                }
            }

            // Token file never appeared — fall back to HTTP bootstrap via
            // /v1/guardian/init. This path generates its own random bootstrap
            // secret which may fail if the runtime already consumed the real one.
            log.warning("Guardian token file not found after \(maxAttempts) polls — falling back to /v1/guardian/init")
        } else {
            log.info("performInitialBootstrap: skipFileImport=true — driving HTTP reprovision path directly")
        }

        let deviceId = PairingQRCodeSheet.computeHostId()
        let retryDelay: UInt64 = 500_000_000

        // Self-heal path: if a refresh token survives in the keychain (e.g.
        // from a slightly-stale CLI file import or a prior run), try to
        // rotate it into a fresh access/refresh pair before hitting the
        // bootstrap-lockfile-guarded init endpoint. The lockfile permanently
        // 403s /v1/guardian/init after first use, so init alone has no path
        // to recover — whereas refresh succeeds whenever the server still
        // recognizes the refresh token, covering the common
        // "access-expired-but-refresh-still-valid" case.
        if ActorTokenManager.getRefreshToken() != nil {
            if !connectionManager.isConnected {
                await awaitConnectionEstablished()
                guard !Task.isCancelled else { return }
            }
            let refreshResult = await ActorCredentialRefresher.refresh(
                platform: "macos",
                deviceId: deviceId
            )
            switch refreshResult {
            case .success:
                log.info("Initial actor token bootstrap recovered via refresh")
                return
            case .terminalError(let reason):
                log.warning("Refresh terminal error (\(reason, privacy: .public)) — clearing credentials and falling back to /v1/guardian/init")
                ActorTokenManager.deleteAllCredentials()
            case .transientError:
                log.info("Refresh transient error — falling back to /v1/guardian/init")
            }
        }

        while !Task.isCancelled {
            if !connectionManager.isConnected {
                await awaitConnectionEstablished()
                guard !Task.isCancelled else { return }
            }

            let success = await GuardianClient().bootstrapActorToken(
                platform: "macos",
                deviceId: deviceId
            )

            if success {
                log.info("Initial actor token bootstrap succeeded via HTTP fallback")
                return
            }

            let jitter = UInt64.random(in: 0...(retryDelay / 4))
            try? await Task.sleep(nanoseconds: retryDelay + jitter)
        }
    }

    /// Suspends until `connectionManager.isConnected` becomes `true`,
    /// or the task is cancelled.
    @MainActor
    private func awaitConnectionEstablished() async {
        guard !connectionManager.isConnected else { return }
        for await isConnected in connectionManager.isConnectedStream where isConnected {
            return
        }
    }
}
