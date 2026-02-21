import Foundation
import Network
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

// MARK: - Connection Management

extension DaemonClient {

    // MARK: - Connect

    /// How long to wait for a connection before giving up.
    static let connectTimeout: TimeInterval = 5.0
    static let authTimeout: TimeInterval = 5.0

    /// Connect to the daemon. If already connected, disconnects first.
    /// - macOS (socket): Connects to Unix domain socket at `~/.vellum/vellum.sock`
    /// - HTTP: Connects to remote assistant via HTTP REST + SSE (both platforms)
    /// - iOS (tcp): Connects to TCP endpoint (hostname from UserDefaults or localhost:8765)
    public func connect() async throws {
        // Disconnect any existing connection without triggering reconnect.
        disconnectInternal(triggerReconnect: false)

        isConnecting = true
        shouldReconnect = true

        // Check if we should use HTTP transport for a remote assistant (both platforms).
        if case .http(let baseURL, let bearerToken, let conversationKey) = config.transport {
            try await connectHTTP(baseURL: baseURL, bearerToken: bearerToken, conversationKey: conversationKey)
            return
        }

        let endpoint: NWEndpoint
        let parameters: NWParameters

        #if os(macOS)
        if case .socket(let path) = config.transport {
            log.info("Connecting to daemon socket at \(path, privacy: .public)")
            endpoint = NWEndpoint.unix(path: path)
            parameters = NWParameters()
            parameters.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
        } else if case .tcp(let h, let p, let tls, _) = config.transport {
            log.info("Connecting to daemon at \(h):\(p) (tls=\(tls))")
            endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(h), port: NWEndpoint.Port(integerLiteral: p))
            parameters = tls ? .tls : .tcp
        } else {
            isConnecting = false
            return
        }
        #elseif os(iOS)
        // HTTP transport is already handled above; only TCP should reach here on iOS.
        guard case .tcp(let configHostname, let configPort, let configTls, _) = config.transport else {
            log.error("Unexpected transport type on iOS — HTTP should have been handled above")
            isConnecting = false
            return
        }

        // Check UserDefaults first to pick up runtime changes, fall back to config
        // This allows reconnects to pick up changed settings while preserving custom configs for tests
        let hostname: String
        let port: UInt16

        if let userHostname = UserDefaults.standard.string(forKey: "daemon_hostname"), !userHostname.isEmpty {
            hostname = userHostname
        } else {
            hostname = configHostname
        }

        let rawPort = UserDefaults.standard.integer(forKey: "daemon_port")
        if rawPort > 0 && rawPort <= 65535 {
            port = UInt16(rawPort)
        } else {
            port = configPort
        }

        // Also re-read TLS setting from UserDefaults on each connect to match hostname/port behaviour
        let tlsEnabled: Bool
        if UserDefaults.standard.object(forKey: "daemon_tls_enabled") != nil {
            tlsEnabled = UserDefaults.standard.bool(forKey: "daemon_tls_enabled")
        } else {
            tlsEnabled = configTls
        }

        log.info("Connecting to daemon at \(hostname):\(port) (tls=\(tlsEnabled))")
        endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(hostname),
            port: NWEndpoint.Port(integerLiteral: port)
        )
        parameters = tlsEnabled ? .tls : .tcp
        #else
        #error("DaemonClient is only supported on macOS and iOS")
        #endif

        let conn = NWConnection(to: endpoint, using: parameters)
        self.connection = conn

        try await withCheckedThrowingContinuation { (checkedContinuation: CheckedContinuation<Void, Error>) in
            var resumed = false

            // Timeout: if we haven't connected within the deadline, fail.
            let timeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(Self.connectTimeout * 1_000_000_000))
                } catch { return }

                guard !resumed else { return }
                resumed = true
                log.error("Connection timed out after \(Self.connectTimeout)s")
                self?.isConnected = false
                self?.isConnecting = false
                self?.stopPingTimer()
                conn.stateUpdateHandler = nil
                conn.cancel()
                checkedContinuation.resume(throwing: NWError.posix(.ETIMEDOUT))
            }

            conn.stateUpdateHandler = { [weak self] state in
                guard let self else { return }

                Task { @MainActor in
                    switch state {
                    case .ready:
                        if !resumed {
                            resumed = true
                            timeoutTask.cancel()
                            log.info("Connected to daemon socket")
                            self.startReceiveLoop()
                            Task { @MainActor in
                                do {
                                    #if os(macOS)
                                    try await self.authenticate()
                                    #elseif os(iOS)
                                    try await self.authenticateIfNeeded()
                                    #else
                                    self.isAuthenticated = true
                                    #endif
                                    self.isConnected = true
                                    self.isConnecting = false
                                    self.startNetworkMonitor()
                                    NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
                                    self.reconnectDelay = 1.0
                                    self.startPingTimer()
                                    #if os(macOS)
                                    self.runBlobProbe()
                                    #endif
                                    checkedContinuation.resume()
                                } catch {
                                    log.error("Daemon authentication failed: \(error.localizedDescription)")
                                    self.isConnected = false
                                    self.isConnecting = false
                                    self.isAuthenticated = false
                                    self.stopPingTimer()
                                    conn.stateUpdateHandler = nil
                                    conn.cancel()
                                    checkedContinuation.resume(throwing: error)
                                }
                            }
                        }

                    case .failed(let error):
                        log.error("Connection failed: \(error.localizedDescription)")
                        self.isConnected = false
                        self.isConnecting = false
                        self.isAuthenticated = false
                        self.stopPingTimer()
                        if !resumed {
                            resumed = true
                            timeoutTask.cancel()
                            checkedContinuation.resume(throwing: error)
                        } else {
                            self.scheduleReconnect()
                        }

                    case .cancelled:
                        log.info("Connection cancelled")
                        self.isConnected = false
                        self.isConnecting = false
                        self.isAuthenticated = false
                        self.stopPingTimer()
                        if !resumed {
                            resumed = true
                            timeoutTask.cancel()
                            checkedContinuation.resume(throwing: NWError.posix(.ECANCELED))
                        }

                    case .waiting(let error):
                        log.warning("Connection waiting: \(String(describing: error), privacy: .public)")
                        // Don't resume the continuation yet; NWConnection may still transition to .ready.
                        // The timeout task will handle the case where it never does.

                    default:
                        break
                    }
                }
            }

            conn.start(queue: self.queue)
        }
    }

    // MARK: - Authentication

    #if os(macOS)
    func authenticate() async throws {
        // Try session-token file first, then fall back to transport's configured authToken
        let transportToken: String? = {
            if case .tcp(_, _, _, let t) = config.transport { return t }
            return nil
        }()
        guard let token = readSessionToken() ?? transportToken else {
            throw AuthError.missingToken
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            authContinuation?.resume(throwing: AuthError.rejected("Authentication superseded"))
            authContinuation = continuation

            authTimeoutTask?.cancel()
            authTimeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(Self.authTimeout * 1_000_000_000))
                } catch {
                    return
                }
                guard let self, let pending = self.authContinuation else { return }
                self.authContinuation = nil
                self.authTimeoutTask = nil
                self.isAuthenticated = false
                pending.resume(throwing: AuthError.timeout)
            }

            do {
                try self.send(AuthMessage(token: token))
            } catch {
                authContinuation = nil
                authTimeoutTask?.cancel()
                authTimeoutTask = nil
                continuation.resume(throwing: error)
            }
        }
    }
    #endif

    #if os(iOS)
    /// Perform token-based authentication if `config.authToken` is set.
    /// Sends an `AuthMessage` and waits for an `auth_result` response before
    /// allowing the connection to be marked as ready.
    /// If no token is configured, marks the connection as authenticated immediately.
    func authenticateIfNeeded() async throws {
        // Re-read from Keychain on each call to pick up runtime changes (mirrors hostname/port pattern).
        // Falls back to legacy UserDefaults key with one-time migration (same logic as DaemonConfig).
        let tokenFromKeychain = APIKeyManager.shared.getAPIKey(provider: "daemon-token")
            ?? DaemonConfig.migrateAuthToken()
        guard let token = tokenFromKeychain ?? config.authToken else {
            // No token configured — treat as unauthenticated (plain TCP, no handshake).
            isAuthenticated = true
            return
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            authContinuation?.resume(throwing: AuthError.rejected("Authentication superseded"))
            authContinuation = continuation

            authTimeoutTask?.cancel()
            authTimeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(Self.authTimeout * 1_000_000_000))
                } catch {
                    return
                }
                guard let self, let pending = self.authContinuation else { return }
                self.authContinuation = nil
                self.authTimeoutTask = nil
                self.isAuthenticated = false
                pending.resume(throwing: AuthError.timeout)
            }

            do {
                try self.send(AuthMessage(token: token))
            } catch {
                authContinuation = nil
                authTimeoutTask?.cancel()
                authTimeoutTask = nil
                continuation.resume(throwing: error)
            }
        }
    }
    #endif

    // MARK: - HTTP Transport

    /// Connect to a remote assistant via HTTP REST + SSE.
    /// Used when `config.transport` is `.http`.
    func connectHTTP(baseURL: String, bearerToken: String?, conversationKey: String) async throws {
        let transport = HTTPTransport(
            baseURL: baseURL,
            bearerToken: bearerToken,
            conversationKey: conversationKey
        )

        // Wire incoming SSE messages through the existing handleServerMessage infrastructure.
        transport.onMessage = { [weak self] message in
            self?.handleServerMessage(message)
        }

        // Bridge HTTP transport connection state to DaemonClient's @Published isConnected.
        transport.onConnectionStateChanged = { [weak self] connected in
            guard let self else { return }
            self.isConnected = connected
            self.isConnecting = false
            if connected {
                NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
            }
        }

        self.httpTransport = transport

        do {
            try await transport.connect()
            // isConnected is set by the onConnectionStateChanged callback
            // when the SSE stream establishes.
            isAuthenticated = true  // HTTP transport uses bearer token, no IPC auth needed
            isConnecting = false
        } catch {
            isConnecting = false
            httpTransport = nil
            throw error
        }
    }

    // MARK: - Disconnect

    /// Disconnect from the daemon. Stops reconnect and ping timers.
    public func disconnect() {
        disconnectInternal(triggerReconnect: false)
    }

    func disconnectInternal(triggerReconnect: Bool) {
        shouldReconnect = triggerReconnect
        reconnectTask?.cancel()
        reconnectTask = nil
        if !triggerReconnect {
            stopNetworkMonitor()
        }
        stopPingTimer()
        #if os(macOS) || os(iOS)
        if let pending = authContinuation {
            authContinuation = nil
            authTimeoutTask?.cancel()
            authTimeoutTask = nil
            pending.resume(throwing: AuthError.rejected("Disconnected"))
        }
        authTimeoutTask?.cancel()
        authTimeoutTask = nil
        #endif
        blobProbeTask?.cancel()
        blobProbeTask = nil
        pendingProbeId = nil
        isBlobTransportAvailable = false
        isAuthenticated = false

        httpTransport?.disconnect()
        httpTransport = nil

        if let conn = connection {
            conn.stateUpdateHandler = nil
            conn.cancel()
            connection = nil
        }

        receiveBuffer = Data()
        cuObservationSequenceBySession.removeAll()
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

    // MARK: - Receive Loop

    func startReceiveLoop() {
        guard let conn = connection else { return }
        receiveData(on: conn)
    }

    func receiveData(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] content, _, isComplete, error in
            guard let self else { return }

            Task { @MainActor in
                if let data = content, !data.isEmpty {
                    self.processReceivedData(data)
                }

                if isComplete {
                    log.info("Connection received EOF")
                    self.handleUnexpectedDisconnect()
                    return
                }

                if let error {
                    log.error("Receive error: \(error.localizedDescription)")
                    self.handleUnexpectedDisconnect()
                    return
                }

                // Continue reading.
                self.receiveData(on: conn)
            }
        }
    }

    /// Buffer incoming data, split on newlines, decode each complete line as ServerMessage.
    func processReceivedData(_ data: Data) {
        receiveBuffer.append(data)

        // Check max buffer size.
        if receiveBuffer.count > maxLineSize {
            log.error("Receive buffer exceeded max line size (\(self.maxLineSize) bytes), clearing buffer")
            receiveBuffer = Data()
            return
        }

        // Split on newlines.
        let newline = UInt8(0x0A)
        while let newlineIndex = receiveBuffer.firstIndex(of: newline) {
            let lineData = receiveBuffer[receiveBuffer.startIndex..<newlineIndex]
            receiveBuffer = receiveBuffer[(newlineIndex + 1)...]

            // Skip empty lines.
            guard !lineData.isEmpty else { continue }

            do {
                let message = try decoder.decode(ServerMessage.self, from: Data(lineData))
                handleServerMessage(message)
            } catch {
                // Log a safe summary — never include raw line content which may contain secrets.
                let byteCount = lineData.count
                let typeHint = extractMessageType(from: Data(lineData))
                log.error("Failed to decode server message: \(error.localizedDescription), bytes: \(byteCount), type: \(typeHint)")
            }
        }
    }

    // MARK: - Blob Probe (macOS only)

    #if os(macOS)
    /// Initiate a blob probe after connecting. Writes a nonce file to the shared
    /// blob directory and sends a probe message to the daemon. The daemon reads
    /// the file, hashes it, and responds. If the hashes match, blob transport
    /// is confirmed available for this connection.
    func runBlobProbe() {
        blobProbeTask?.cancel()
        isBlobTransportAvailable = false

        blobProbeTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let store = IpcBlobStore.shared
            store.ensureDirectory()

            guard let probe = store.writeProbeFile() else {
                log.warning("Blob probe: failed to write probe file")
                return
            }

            self.pendingProbeId = probe.probeId

            do {
                try self.send(IpcBlobProbeMessage(
                    probeId: probe.probeId,
                    nonceSha256: probe.nonceSha256
                ))
                log.info("Blob probe sent: \(probe.probeId)")
            } catch {
                log.warning("Blob probe: failed to send probe message: \(error.localizedDescription)")
                self.pendingProbeId = nil
            }
        }
    }
    #endif

    /// Process a blob probe result from the daemon.
    /// Internal (not private) for testability via @testable import.
    func handleBlobProbeResult(_ result: IpcBlobProbeResultMessage) {
        guard result.probeId == pendingProbeId else {
            log.warning("Blob probe: ignoring stale result for \(result.probeId) (expected \(self.pendingProbeId ?? "nil"))")
            return
        }
        pendingProbeId = nil

        if result.ok {
            isBlobTransportAvailable = true
            log.info("Blob transport verified for this connection")
        } else {
            isBlobTransportAvailable = false
            log.warning("Blob probe failed: \(result.reason ?? "unknown")")
        }
    }

    // MARK: - Reconnect

    func handleUnexpectedDisconnect() {
        disconnectInternal(triggerReconnect: shouldReconnect)
        if shouldReconnect {
            // Re-enable reconnect since disconnectInternal sets it based on the parameter.
            self.shouldReconnect = true
            scheduleReconnect()
        }
    }

    func scheduleReconnect() {
        guard shouldReconnect else { return }
        reconnectTask?.cancel()

        let delay = reconnectDelay
        log.info("Scheduling reconnect in \(delay)s")

        reconnectTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return // Cancelled.
            }

            guard let self, self.shouldReconnect else { return }

            // Increase backoff for next attempt.
            self.reconnectDelay = min(self.reconnectDelay * 2, self.maxReconnectDelay)

            do {
                try await self.connect()
            } catch {
                log.error("Reconnect failed: \(error.localizedDescription)")
                // connect() failure will trigger another scheduleReconnect via stateUpdateHandler
                // only if we haven't already scheduled one.
                if self.shouldReconnect && self.reconnectTask == nil {
                    self.scheduleReconnect()
                }
            }
        }
    }

    // MARK: - Network Reachability

    func startNetworkMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                self?.handleNetworkPathChange(path)
            }
        }
        monitor.start(queue: pathMonitorQueue)
        pathMonitor = monitor
    }

    func stopNetworkMonitor() {
        pathMonitor?.cancel()
        pathMonitor = nil
    }

    func handleNetworkPathChange(_ path: NWPath) {
        guard path.status == .satisfied, !isConnected, !isConnecting, shouldReconnect else { return }
        log.info("Network available — resetting backoff and reconnecting immediately")
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectDelay = 1.0
        isConnecting = true
        Task { @MainActor [weak self] in
            guard let self, self.shouldReconnect else {
                self?.isConnecting = false
                return
            }
            do {
                try await self.connect()
            } catch {
                log.error("Immediate reconnect on network change failed: \(error.localizedDescription)")
                self.scheduleReconnect()
            }
        }
    }

    // MARK: - Ping / Pong

    func startPingTimer() {
        stopPingTimer()

        pingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000) // 30 seconds
                } catch {
                    return // Cancelled.
                }

                guard let self, self.isConnected else { return }

                self.sendPing()
            }
        }
    }

    func stopPingTimer() {
        pingTask?.cancel()
        pingTask = nil
        pongTimeoutTask?.cancel()
        pongTimeoutTask = nil
        awaitingPong = false
    }

    /// Extract the "type" field from raw JSON data for safe logging.
    /// Returns the type string if parseable, otherwise "<unknown>".
    /// This avoids logging the entire line which may contain sensitive values.
    func extractMessageType(from data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return "<unknown>"
        }
        return type
    }

    func sendPing() {
        do {
            try send(PingMessage())
            awaitingPong = true

            // Start pong timeout.
            pongTimeoutTask?.cancel()
            pongTimeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000) // 10 seconds
                } catch {
                    return // Cancelled.
                }

                guard let self, self.awaitingPong else { return }
                log.warning("Pong timeout, reconnecting")
                self.handleUnexpectedDisconnect()
            }
        } catch {
            log.error("Failed to send ping: \(error.localizedDescription)")
        }
    }
}
