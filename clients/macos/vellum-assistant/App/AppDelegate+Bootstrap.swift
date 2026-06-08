import AppKit
import Combine
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate")
private let selfIntroGreetingFeatureFlag = "self-intro-greeting"

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
        if newState == .complete {
            drainPendingConversationOpenRequestIfNeeded()
        }

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

        let greeting: String
        if featureFlagStore.isEnabled(selfIntroGreetingFeatureFlag) {
            greeting = pendingPreChatContext?.initialMessage ?? wakeUpGreeting()
        } else {
            greeting = wakeUpGreeting()
        }
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
                        deviceId: HostIdComputer.computeHostId()
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
    /// Recovery must invalidate every guardian-token file the bootstrap path
    /// might re-import — including copies in sibling-env config dirs that the
    /// CLI's `seedGuardianTokenFromSiblingEnv` would otherwise restore on the
    /// next `vellum wake`. Refresh-window expiry is a clock check, not a
    /// server-validity check, so a server-revoked token whose refresh hasn't
    /// elapsed will silently re-arm itself if any sibling-env copy survives.
    ///
    /// For local/bare-metal hatches we additionally clear the guardian-init
    /// lockfile so `/v1/guardian/init` can be called again — the lockfile is
    /// one-time-use after first successful hatch on bare-metal.
    ///
    /// We always pass `skipFileImport: true` so recovery is driven exclusively
    /// by the HTTP path; `bootstrapActorToken` will surface its own errors if
    /// the gateway is unreachable.
    func forceReBootstrap() async {
        log.info("forceReBootstrap: clearing stored credentials and re-running bootstrap")
        ActorTokenManager.deleteAllCredentials()

        if let assistantId = LockfileAssistant.loadActiveAssistantId() {
            let removed = GuardianTokenFileReader.deleteTokenFileAcrossAllEnvs(
                assistantId: assistantId
            )
            log.info("forceReBootstrap: removed \(removed, privacy: .public) stale guardian-token file(s) across env dirs")

            // When the lockfile entry can't be resolved, default to treating
            // the hatch as remote (skip lock reset) — matches the prior
            // ambiguous-state convention.
            let assistant = LockfileAssistant.loadByName(assistantId)
            let isRemoteHatch = assistant?.isRemote ?? true
            if assistant == nil {
                log.warning("forceReBootstrap: could not resolve lockfile entry for active assistant — treating as remote hatch")
            }
            if !isRemoteHatch {
                let cleared = await GuardianClient().resetBootstrap(
                    bootstrapSecret: assistant?.guardianBootstrapSecret
                )
                if !cleared {
                    log.warning("forceReBootstrap: reset-bootstrap failed — HTTP fallback may still be locked out")
                }
            }
        }
        await performInitialBootstrap(skipFileImport: true)
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
    /// entirely and jump straight to the HTTP fallback. `forceReBootstrap()`
    /// always passes `true` so recovery is driven exclusively by the HTTP
    /// path.
    func performInitialBootstrap(skipFileImport: Bool = false) async {
        guard let assistantId = LockfileAssistant.loadActiveAssistantId() else { return }

        if !skipFileImport {
            // Try importing a guardian token that was already written to disk
            // (e.g. by the CLI during hatch or by AppleContainersLauncher).
            if GuardianTokenFileReader.importIfAvailable(assistantId: assistantId) {
                log.info("Imported guardian token from file — skipping HTTP bootstrap")
                return
            }

            // On remote hatches (Docker, cloud, managed) the CLI/launcher
            // writes guardian-token.json asynchronously — poll for it. On
            // bare-metal the file is written synchronously at hatch time, so
            // if the first check missed it the file isn't coming.
            //
            // When the lockfile entry can't be resolved, default to treating
            // the hatch as remote (poll) to stay aligned with
            // `forceReBootstrap()`'s "treat unresolved as remote" default.
            // A bare-metal run with an unresolvable entry otherwise falls
            // straight into `/v1/guardian/init`, which is permanently 403'd
            // after the first hatch — producing a non-recovering loop.
            // Polling first gives the CLI/launcher a chance to (re)write the
            // token file before the HTTP fallback is exercised.
            let assistant = LockfileAssistant.loadByName(assistantId)
            let shouldPoll = assistant?.isRemote ?? true
            if assistant == nil {
                log.warning("performInitialBootstrap: could not resolve lockfile entry for active assistant — polling for guardian token file before HTTP fallback")
            }

            if shouldPoll {
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
                log.warning("Guardian token file not found after \(maxAttempts) polls — falling back to /v1/guardian/init")
            } else {
                log.info("Local hatch — skipping token file poll, falling back to /v1/guardian/init")
            }
        } else {
            log.info("performInitialBootstrap: skipFileImport=true — driving HTTP reprovision path directly")
        }

        let deviceId = HostIdComputer.computeHostId()
        let retryDelay: UInt64 = 500_000_000

        // Self-heal path: if a refresh token survives in the keychain (e.g.
        // from a slightly-stale CLI file import or a prior run), try to
        // rotate it into a fresh access/refresh pair before hitting the
        // bootstrap-lockfile-guarded init endpoint. The lockfile permanently
        // 403s /v1/guardian/init after first use, so init alone has no path
        // to recover — whereas refresh succeeds whenever the server still
        // recognizes the refresh token, covering the common
        // "access-expired-but-refresh-still-valid" case.
        //
        // NOTE: We do NOT gate on `connectionManager.isConnected` here.
        // After the loopback auth-bypass removal, `isConnected` requires a
        // successful health check (which itself requires valid auth), creating
        // a circular dependency. The `/v1/guardian/refresh` endpoint is a
        // dedicated gateway route reachable as long as the gateway process is
        // listening — if it isn't up yet, the HTTP call fails gracefully and
        // we fall through to the guardian/init retry loop.
        if ActorTokenManager.getRefreshToken() != nil {
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

        // HTTP /v1/guardian/init does NOT gate on `connectionManager.isConnected`.
        // `isConnected` flips true only after a 200 health-check response,
        // which requires auth — and the whole point of this loop is to mint
        // the credential that the health check would use. Gating here would
        // deadlock initial bootstrap whenever an existing keychain token has
        // been wiped (re-pair / refresh-token revoked / first-launch-after-
        // sibling-env cleanup). `bootstrapActorToken` is itself an HTTP POST
        // — it will surface gateway-down errors via its return value, and the
        // retry loop handles transient failures.
        while !Task.isCancelled {
            let bootstrapSecret = LockfileAssistant.loadByName(assistantId)?.guardianBootstrapSecret
            let success = await GuardianClient().bootstrapActorToken(
                platform: "macos",
                deviceId: deviceId,
                bootstrapSecret: bootstrapSecret
            )

            if success {
                log.info("Initial actor token bootstrap succeeded via HTTP fallback")
                return
            }

            let jitter = UInt64.random(in: 0...(retryDelay / 4))
            try? await Task.sleep(nanoseconds: retryDelay + jitter)
        }
    }
}
