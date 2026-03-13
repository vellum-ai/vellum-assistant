import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

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
        log.info("Bootstrap state: \(self.bootstrapState.rawValue) → \(newState.rawValue)")
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

    /// Polls daemon connection state at ~0.5s intervals. Does NOT call
    /// `connect()` itself — that is the sole responsibility of
    /// `setupDaemonClient()`. This avoids a dual-connect race where two
    /// concurrent Tasks both attempt `daemonClient.connect()`, with the
    /// second caller's `disconnectInternal()` tearing down the first
    /// caller's in-flight HTTP connection.
    func awaitDaemonReady(timeout: TimeInterval) async -> Bool {
        log.info("Waiting for daemon to become ready (timeout: \(timeout)s)")
        let start = CFAbsoluteTimeGetCurrent()

        while CFAbsoluteTimeGetCurrent() - start < timeout {
            if daemonClient.isConnected {
                log.info("Daemon is connected")
                return true
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }

        log.warning("awaitDaemonReady timed out after \(timeout)s")
        return daemonClient.isConnected
    }

    /// Sends the wake-up greeting. If the daemon is disconnected, waits for
    /// reconnection before proceeding. Since `showMainWindow` always creates
    /// the window (via `ensureMainWindowExists`), there is no need for a
    /// retry loop — a simple guard suffices.
    func performRetriableWakeUpSend() async {
        guard !Task.isCancelled else { return }

        // If daemon disconnected, wait for reconnection before trying
        if !daemonClient.isConnected {
            log.warning("Daemon disconnected during wake-up send — waiting for reconnection")
            let reconnected = await awaitDaemonReady(timeout: 15)
            if !reconnected {
                log.warning("Daemon did not reconnect — showing timeout screen")
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
    /// transitions to `.complete` when the daemon's first reply arrives.
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
            log.info("Daemon instance changed — re-running credential bootstrap")
            Task { @MainActor in
                self.ensureActorCredentials()
            }
        }

        actorTokenBootstrapTask = Task { [weak self] in
            guard let self else { return }

            // If we have no actor token at all, we need initial bootstrap
            if !ActorTokenManager.hasToken {
                await self.performInitialBootstrap()
            }

            // Run proactive refresh loop
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000) // Check every 5 minutes
                guard !Task.isCancelled else { return }

                if ActorTokenManager.needsProactiveRefresh {
                    guard self.daemonClient.isConnected else { continue }

                    let baseURL: String
                    let bearerToken: String?
                    if let httpTransport = self.daemonClient.httpTransport {
                        baseURL = httpTransport.baseURL
                        bearerToken = httpTransport.bearerToken
                    } else if let port = self.daemonClient.httpPort {
                        baseURL = "http://localhost:\(port)"
                        bearerToken = ActorTokenManager.getToken()
                    } else {
                        continue
                    }

                    let result = await ActorCredentialRefresher.refresh(
                        baseURL: baseURL,
                        bearerToken: bearerToken,
                        platform: "macos",
                        deviceId: PairingQRCodeSheet.computeHostId()
                    )

                    switch result {
                    case .success:
                        log.info("Proactive token refresh succeeded")
                        if let token = ActorTokenManager.getToken(), !token.isEmpty {
                            self.daemonClient.updateTransportBearerToken(token)
                        }
                    case .terminalError(let reason):
                        log.error("Proactive token refresh failed terminally: \(reason)")
                    case .transientError:
                        log.warning("Proactive token refresh encountered transient error — will retry")
                    }
                }
            }
        }
    }

    /// Performs the initial actor token bootstrap with exponential backoff.
    /// Called only when no actor token exists (first launch or after credential wipe).
    func performInitialBootstrap() async {
        let deviceId = PairingQRCodeSheet.computeHostId()
        var delay: UInt64 = 2_000_000_000
        let maxDelay: UInt64 = 60_000_000_000
        var connectionDelay: UInt64 = 2_000_000_000
        let connectionMaxDelay: UInt64 = 300_000_000_000

        while !Task.isCancelled {
            guard daemonClient.isConnected else {
                try? await Task.sleep(nanoseconds: connectionDelay)
                connectionDelay = min(connectionDelay * 2, connectionMaxDelay)
                continue
            }

            let success = await daemonClient.bootstrapActorToken(
                platform: "macos",
                deviceId: deviceId
            )

            if success {
                log.info("Initial actor token bootstrap succeeded")
                // Push the new actor token to the HTTP transport so SSE and
                // API requests authenticate with the full-scope JWT instead
                // of the http-token file (which may lack required scopes).
                if let token = ActorTokenManager.getToken(), !token.isEmpty {
                    daemonClient.updateTransportBearerToken(token)
                }
                return
            }

            let jitter = UInt64.random(in: 0...(delay / 4))
            try? await Task.sleep(nanoseconds: delay + jitter)
            delay = min(delay * 2, maxDelay)
        }
    }
}
