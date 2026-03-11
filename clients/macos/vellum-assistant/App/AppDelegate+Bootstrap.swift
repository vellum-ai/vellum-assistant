import AppKit
import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

/// Tracks the first-launch bootstrap sequence so the app can resume
/// from the correct phase after a restart mid-bootstrap.
/// Raw values are persisted in UserDefaults under `"bootstrapState"`.
enum BootstrapState: String {
    case pendingDaemon = "pendingDaemon"
    case pendingWakeupSend = "pendingWakeupSend"
    case pendingFirstReply = "pendingFirstReply"
    case complete = "complete"
}

/// Categorises the most recent bootstrap failure so diagnostic messages
/// can be specific rather than generic escalating text.
enum BootstrapFailureKind {
    case daemonNotRunning
    case connectionRefused
    case gatewayUnhealthy
    case authFailed
    case unknown
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
            case .pendingDaemon:
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

    // MARK: - Bootstrap Interstitial

    /// Shows a blocking interstitial window during first-launch bootstrap when
    /// the daemon is slow to start. The interstitial auto-retries daemon
    /// connection every 2 seconds and transitions to the chat with the wake-up
    /// greeting once the daemon connects.
    func showBootstrapInterstitial() {
        guard bootstrapInterstitialWindow == nil else { return }

        let interstitialView = BootstrapInterstitialView(
            isRetrying: true,
            onRetry: { [weak self] in
                self?.bootstrapInterstitialRetry()
            }
        )

        let hostingController = NSHostingController(rootView: interstitialView)
        hostingController.sizingOptions = []  // Prevent auto-resizing from SwiftUI
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 300),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 380, height: 300))
        window.center()

        NSApp.activateAsDockAppIfNeeded()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        bootstrapInterstitialWindow = window

        // Start auto-retry polling for daemon readiness
        startBootstrapRetryCoordinator()
    }

    /// Updates the interstitial view content (error message and retry state).
    func updateBootstrapInterstitial(errorMessage: String? = nil, isRetrying: Bool = true) {
        guard let window = bootstrapInterstitialWindow else { return }

        let updatedView = BootstrapInterstitialView(
            errorMessage: errorMessage,
            isRetrying: isRetrying,
            onRetry: { [weak self] in
                self?.bootstrapInterstitialRetry()
            }
        )
        let hostingController = NSHostingController(rootView: updatedView)
        hostingController.sizingOptions = []  // Prevent auto-resizing from SwiftUI
        window.contentViewController = hostingController
    }

    /// Dismisses the bootstrap interstitial window and cancels any retry tasks.
    /// Use this for external cleanup callers that need to stop the retry loop.
    func dismissBootstrapInterstitial() {
        bootstrapRetryTask?.cancel()
        bootstrapRetryTask = nil
        bootstrapInterstitialWindow?.close()
        bootstrapInterstitialWindow = nil
    }

    /// Closes only the interstitial window without cancelling the retry task.
    /// Use this from within `startBootstrapRetryCoordinator()` to avoid
    /// self-cancellation when the task dismisses the window upon success.
    func dismissBootstrapInterstitialWindow() {
        bootstrapInterstitialWindow?.close()
        bootstrapInterstitialWindow = nil
    }

    /// Manual retry triggered by the "Try Again" button in the interstitial.
    func bootstrapInterstitialRetry() {
        bootstrapRetryTask?.cancel()
        startBootstrapRetryCoordinator()
    }

    /// Starts a background task that polls daemon readiness every 2 seconds.
    /// When the daemon connects, dismisses the interstitial and proceeds
    /// with the mandatory wake-up send. Shows escalating diagnostic messages
    /// if the daemon takes too long to connect.
    func startBootstrapRetryCoordinator() {
        bootstrapRetryTask?.cancel()
        updateBootstrapInterstitial(isRetrying: true)

        let retryStart = CFAbsoluteTimeGetCurrent()

        bootstrapRetryTask = Task {
            while !Task.isCancelled {
                // Reset so the displayed message always reflects the most
                // recent failure, not a stale one from a previous iteration.
                bootstrapFailureKind = .unknown

                if daemonClient.isConnected {
                    // Daemon is connected — check gateway health before proceeding.
                    // Remote assistants don't run a local gateway, so skip the check.
                    let gatewayHealthy = await isGatewayHealthy()
                    let gatewayOk = isCurrentAssistantRemote || gatewayHealthy
                    if !gatewayOk {
                        // Gateway is unhealthy but daemon is connected. Record for
                        // diagnostics but proceed anyway — the gateway being down
                        // only affects external ingress (Twilio, OAuth), not core
                        // assistant functionality. Blocking here causes a deadlock
                        // when the lockfile-exists fallback hatches with daemonOnly.
                        bootstrapFailureKind = .gatewayUnhealthy
                        log.warning("Gateway unhealthy during bootstrap retry but daemon is connected — proceeding anyway (some features like Twilio/OAuth ingress may be unavailable)")
                    } else {
                        log.info("Daemon connected during bootstrap retry — proceeding to wake-up send")
                    }
                    transitionBootstrap(to: .pendingWakeupSend)
                    dismissBootstrapInterstitialWindow()
                    await performRetriableWakeUpSend()
                    if !Task.isCancelled {
                        bootstrapRetryTask = nil
                    }
                    return
                }

                // If the daemon process isn't running (e.g. hatch failed),
                // re-attempt hatch so we don't loop forever on connect-only retries.
                // Managed mode skips local hatch — the platform hosts the daemon.
                if !isCurrentAssistantManaged {
                    if !DaemonClient.isDaemonProcessAlive() {
                        bootstrapFailureKind = .daemonNotRunning
                        log.info("Daemon process not alive during bootstrap retry — re-attempting hatch")
                        try? await assistantCli.hatch(daemonOnly: true)
                    }
                }

                // Attempt a connection if not already connected or in progress.
                if !daemonClient.isConnected && !daemonClient.isConnecting {
                    do {
                        try await daemonClient.connect()
                    } catch {
                        if bootstrapFailureKind == .unknown {
                            if error is DaemonClient.AuthError {
                                bootstrapFailureKind = .authFailed
                            } else {
                                bootstrapFailureKind = .connectionRefused
                            }
                        }
                        log.error("Bootstrap retry connect attempt failed: \(error)")
                    }
                }

                if daemonClient.isConnected {
                    // Connected — verify gateway health before proceeding.
                    // Remote assistants don't run a local gateway, so skip the check.
                    let gatewayHealthy = await isGatewayHealthy()
                    let gatewayOk = isCurrentAssistantRemote || gatewayHealthy
                    if !gatewayOk {
                        // Same rationale as the check above: gateway health is a
                        // warning, not a gate. Blocking here deadlocks when hatch
                        // ran with daemonOnly (lockfile-exists fallback).
                        bootstrapFailureKind = .gatewayUnhealthy
                        log.warning("Gateway unhealthy after bootstrap retry connect but daemon is connected — proceeding anyway (some features like Twilio/OAuth ingress may be unavailable)")
                    } else {
                        log.info("Daemon connected after bootstrap retry connect — proceeding to wake-up send")
                    }
                    transitionBootstrap(to: .pendingWakeupSend)
                    dismissBootstrapInterstitialWindow()
                    await performRetriableWakeUpSend()
                    if !Task.isCancelled {
                        bootstrapRetryTask = nil
                    }
                    return
                }

                // Surface diagnostics so the user isn't staring at a
                // spinner with no context.
                let elapsed = CFAbsoluteTimeGetCurrent() - retryStart
                if elapsed > 30 {
                    updateBootstrapInterstitial(
                        errorMessage: bootstrapDiagnosticMessage(elapsed: elapsed),
                        isRetrying: true
                    )
                }

                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// Returns a user-facing diagnostic message based on the current failure
    /// kind and how long the bootstrap retry has been running.
    func bootstrapDiagnosticMessage(elapsed: CFAbsoluteTime) -> String {
        switch bootstrapFailureKind {
        case .daemonNotRunning:
            if elapsed > 60 {
                return "Unable to restart assistant. Try quitting (\u{2318}Q) and reopening."
            }
            return "Assistant process stopped \u{2014} restarting\u{2026}"

        case .connectionRefused:
            if elapsed > 60 {
                return "Connection keeps failing. Try quitting (\u{2318}Q) and reopening."
            }
            return "Connecting to your assistant\u{2026}"

        case .gatewayUnhealthy:
            if elapsed > 60 {
                return "Network services are not responding. Try quitting (\u{2318}Q) and reopening."
            }
            return "Waiting for network services\u{2026}"

        case .authFailed:
            if elapsed > 60 {
                return "Authentication issue. You may need to re-pair your assistant."
            }
            return "Authenticating\u{2026}"

        case .unknown:
            if elapsed > 120 {
                return "Your assistant is taking unusually long to start. "
                    + "Try quitting the app (\u{2318}Q) and reopening it. "
                    + "If the issue persists, retire and re-hatch your assistant."
            } else if elapsed > 60 {
                return "This is taking longer than expected. "
                    + "A background process may have crashed. "
                    + "The app will keep retrying automatically."
            } else {
                return "Still working on it \u{2014} this can take a minute on first launch."
            }
        }
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
                log.warning("Daemon did not reconnect — showing interstitial for manual retry")
                showBootstrapInterstitial()
                updateBootstrapInterstitial(
                    errorMessage: "Lost connection to your assistant. Retrying...",
                    isRetrying: true
                )
                return
            }
        }

        let greeting = wakeUpGreeting()
        showMainWindow(initialMessage: greeting, isFirstLaunch: true)

        // showMainWindow always creates mainWindow, but guard defensively.
        guard let main = mainWindow else {
            log.error("MainWindow not created after showMainWindow — cannot send wake-up")
            showBootstrapInterstitial()
            updateBootstrapInterstitial(
                errorMessage: "Could not start your assistant. Please try again.",
                isRetrying: false
            )
            return
        }

        log.info("MainWindow created — deferring pendingFirstReply until wake-up message is dispatched")
        main.onWakeUpSent = { [weak self] in
            guard let self else { return }
            log.info("Wake-up greeting actually sent — transitioning to pendingFirstReply")
            self.transitionBootstrap(to: .pendingFirstReply)
            self.wireBootstrapFirstReplyCallback()
        }
        setupWakeWordCoordinator()
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
