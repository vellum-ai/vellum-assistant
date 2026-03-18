import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

// MARK: - Connection Management

extension DaemonClient {

    // MARK: - Connect

    /// Connect to the daemon via HTTP transport. If already connected, disconnects first.
    /// SSE is managed separately via `startSSE()` / `stopSSE()`.
    public func connect() async throws {
        // Disconnect any existing connection without triggering reconnect.
        disconnectInternal(triggerReconnect: false)

        isConnecting = true

        guard case .http(let baseURL, let bearerToken, let conversationKey) = config.transport else {
            isConnecting = false
            log.info("connect: non-HTTP transport, skipping")
            return
        }

        log.info("connect: establishing HTTP transport to \(baseURL, privacy: .public)")

        let transport = HTTPTransport(
            baseURL: baseURL,
            bearerToken: bearerToken,
            conversationKey: conversationKey,
            transportMetadata: config.transportMetadata
        )

        // Wire incoming SSE messages through the existing handleServerMessage infrastructure.
        transport.onMessage = { [weak self] message in
            self?.handleServerMessage(message)
        }

        // Bridge HTTP transport connection state (health-check driven) to DaemonClient.
        transport.onConnectionStateChanged = { [weak self] connected in
            guard let self else { return }
            self.isConnected = connected
            self.isConnecting = false
            if connected {
                NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
            }
            #if os(macOS)
            if !connected {
                self.autoWakeIfDaemonDied()
            }
            #endif
        }

        // Persist refreshed bearer tokens so the client survives app restarts.
        transport.onTokenRefreshed = { newToken in
            #if os(iOS)
            let _ = APIKeyManager.shared.setAPIKey(newToken, provider: "runtime-bearer-token")
            #elseif os(macOS)
            // macOS re-reads from disk on each request; no persistence needed here.
            #endif
        }

        self.httpTransport = transport

        do {
            try await transport.connect()
            isAuthenticated = true  // HTTP transport uses bearer token, no additional auth needed
            isConnecting = false
            log.info("connect: transport connected successfully to \(baseURL, privacy: .public), SSE should be running")
        } catch {
            #if os(macOS)
            // Auto-wake: if the gateway is unreachable and a wake handler is
            // configured, try waking the daemon and retrying the connection once.
            if let wakeHandler, config.transportMetadata.routeMode == .runtimeFlat {
                let reachable = await HealthCheckClient.isReachable(instanceDir: config.instanceDir)
                if !reachable {
                    log.info("connect: gateway unreachable — attempting auto-wake before retry")
                    do {
                        try await wakeHandler()
                        log.info("connect: auto-wake succeeded, retrying connection to \(baseURL, privacy: .public)")
                        try await transport.connect()
                        isAuthenticated = true
                        isConnecting = false
                        log.info("connect: retry after auto-wake succeeded for \(baseURL, privacy: .public)")
                        return
                    } catch {
                        log.error("connect: auto-wake or retry failed for \(baseURL, privacy: .public): \(error)")
                    }
                }
            }
            #endif

            isConnecting = false
            httpTransport = nil
            log.error("connect: transport connection failed for \(baseURL, privacy: .public): \(error)")
            throw error
        }
    }

    // MARK: - SSE Lifecycle

    /// Start the SSE event stream. Call when a chat window opens.
    public func startSSE() {
        httpTransport?.startSSE()
    }

    /// Stop the SSE event stream. Call when a chat window closes.
    public func stopSSE() {
        httpTransport?.stopSSE()
    }

    // MARK: - Token Update

    /// Push a new bearer token to the active HTTP transport. If SSE is currently
    /// disconnected (e.g. due to 403 errors with an older token), this restarts
    /// the SSE stream so it can authenticate with the updated token.
    public func updateTransportBearerToken(_ token: String) {
        httpTransport?.updateBearerToken(token)
    }

    // MARK: - Disconnect

    /// Disconnect from the daemon.
    public func disconnect() {
        disconnectInternal(triggerReconnect: false)
    }

    // MARK: - Auto-Wake on Health Check Disconnect

    #if os(macOS)
    /// Minimum interval between auto-wake attempts to prevent crash loops.
    private static let autoWakeCooldown: TimeInterval = 60.0

    /// Check whether the gateway has become unreachable and, if so, attempt
    /// to wake the daemon and reconnect. Called from the
    /// `onConnectionStateChanged` callback when the health check reports
    /// disconnection.
    private func autoWakeIfDaemonDied() {
        guard let wakeHandler,
              config.transportMetadata.routeMode == .runtimeFlat
        else { return }

        // Crash loop protection: if we already tried recently and the daemon
        // died again, don't keep restarting a broken process.
        if let last = lastAutoWakeAttempt,
           Date().timeIntervalSince(last) < Self.autoWakeCooldown {
            log.warning("auto-wake: skipping — last attempt was within \(Self.autoWakeCooldown)s cooldown")
            return
        }

        lastAutoWakeAttempt = Date()

        autoWakeTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let reachable = await HealthCheckClient.isReachable(instanceDir: self.config.instanceDir)
            guard !reachable else {
                self.lastAutoWakeAttempt = nil
                return
            }

            log.info("auto-wake: gateway unreachable — attempting wake")
            do {
                try await wakeHandler()
                guard !Task.isCancelled else {
                    log.info("auto-wake: cancelled after wake — skipping reconnect")
                    return
                }
                log.info("auto-wake: wake succeeded, reconnecting")
                try await self.connect()
                guard !Task.isCancelled else {
                    log.info("auto-wake: cancelled after connect — abandoning")
                    return
                }
                log.info("auto-wake: reconnect succeeded")
            } catch {
                log.error("auto-wake: failed: \(error)")
            }
        }
    }
    #endif

    func disconnectInternal(triggerReconnect: Bool) {
        isAuthenticated = false

        #if os(macOS)
        autoWakeTask?.cancel()
        autoWakeTask = nil
        #endif

        httpTransport?.disconnect()
        httpTransport = nil

        isConnected = false
        isConnecting = false
        httpPort = nil
        latestMemoryStatus = nil

        // Finish all subscriber streams so `for await` loops terminate
        // instead of hanging forever on disconnect.
        for continuation in subscribers.values {
            continuation.finish()
        }
        subscribers.removeAll()
    }
}
