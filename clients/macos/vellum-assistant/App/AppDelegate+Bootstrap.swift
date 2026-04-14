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

    /// Performs the initial actor token bootstrap, reactively waiting for a
    /// gateway connection before each attempt. Called only when no actor token
    /// exists (first launch or after credential wipe).
    ///
    /// Before hitting the network, checks whether the CLI already persisted a
    /// guardian token to disk (e.g. during a Docker or cloud hatch). If found,
    /// imports it directly and skips the HTTP bootstrap entirely.
    /// Maximum number of times to poll for a guardian token file before
    /// giving up. At 2s intervals this is ~60s of waiting.
    private static let guardianTokenFilePollMaxAttempts = 30
    private static let guardianTokenFilePollDelay: UInt64 = 2_000_000_000 // 2 seconds

    func performInitialBootstrap() async {
        // Try importing a CLI-persisted guardian token first. During non-local
        // hatches the CLI calls /v1/guardian/init and saves the result to
        // ~/.config/vellum/assistants/<id>/guardian-token.json. Importing from
        // this file avoids a redundant (and often 403-failing) HTTP bootstrap.
        if let assistantId = LockfileAssistant.loadActiveAssistantId(),
           GuardianTokenFileReader.importIfAvailable(assistantId: assistantId) {
            log.info("Imported guardian token from CLI file — skipping HTTP bootstrap")
            return
        }

        // For apple-container assistants the launcher (AppleContainersLauncher)
        // handles the one-time bootstrap secret and writes the token file.
        // We must NOT call /v1/guardian/init ourselves — doing so would send a
        // random UUID as the bootstrap secret, racing with the launcher and
        // potentially consuming the one-time secret or triggering a 403.
        // Instead, poll for the token file the launcher will create.
        if let assistant = LockfileAssistant.loadByName(
            LockfileAssistant.loadActiveAssistantId() ?? ""
        ), assistant.isAppleContainer {
            log.info("Apple-container assistant detected — polling for guardian token file instead of HTTP bootstrap")
            for attempt in 1...Self.guardianTokenFilePollMaxAttempts {
                guard !Task.isCancelled else { return }
                try? await Task.sleep(nanoseconds: Self.guardianTokenFilePollDelay)
                guard !Task.isCancelled else { return }

                if GuardianTokenFileReader.importIfAvailable(assistantId: assistant.assistantId) {
                    log.info("Imported guardian token from file after \(attempt) poll(s)")
                    return
                }
            }
            log.warning("Guardian token file did not appear after \(Self.guardianTokenFilePollMaxAttempts) polls — apple-container launcher may have failed")
            return
        }

        let deviceId = PairingQRCodeSheet.computeHostId()
        let retryDelay: UInt64 = 500_000_000

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
                log.info("Initial actor token bootstrap succeeded")
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
