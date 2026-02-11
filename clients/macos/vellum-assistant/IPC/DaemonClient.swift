import Foundation
import Network
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

/// Protocol for daemon client communication, enabling dependency injection and testing.
@MainActor
protocol DaemonClientProtocol {
    func subscribe() -> AsyncStream<ServerMessage>
    func send<T: Encodable>(_ message: T) throws
}

/// Unix domain socket client for communicating with the Vellum daemon.
///
/// Connects to the daemon's socket at `~/.vellum/vellum.sock` (or `VELLUM_DAEMON_SOCKET` env override),
/// sends and receives newline-delimited JSON messages.
///
/// This is a long-lived singleton. Consumers call `subscribe()` to get an independent message
/// stream, enabling multiple consumers (ComputerUseSession, AmbientAgent) to each receive all
/// messages and filter for the ones relevant to them.
@MainActor
final class DaemonClient: ObservableObject, DaemonClientProtocol {

    // MARK: - Published State

    @Published var isConnected: Bool = false

    // MARK: - Broadcast Subscribers

    /// Creates a new message stream for the caller. Each subscriber receives all messages
    /// independently, enabling multiple consumers (ComputerUseSession, AmbientAgent) to
    /// filter for messages relevant to them without competing for elements.
    func subscribe() -> AsyncStream<ServerMessage> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.subscribers.removeValue(forKey: id)
            }
        }
        return stream
    }

    // MARK: - Private State

    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "com.vellum.vellum-assistant.daemon-client", qos: .userInitiated)

    private var subscribers: [UUID: AsyncStream<ServerMessage>.Continuation] = [:]

    /// Buffer for accumulating incoming data until we have complete newline-delimited messages.
    private var receiveBuffer = Data()

    /// Maximum line size: 96 MB (for screenshots with base64).
    private let maxLineSize = 96 * 1024 * 1024

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Current reconnect backoff delay in seconds.
    private var reconnectDelay: TimeInterval = 1.0

    /// Maximum reconnect backoff delay.
    private let maxReconnectDelay: TimeInterval = 30.0

    /// Reconnect task handle.
    private var reconnectTask: Task<Void, Never>?

    /// Ping timer task handle.
    private var pingTask: Task<Void, Never>?

    /// Whether we're waiting for a pong response.
    private var awaitingPong = false

    /// Pong timeout task handle.
    private var pongTimeoutTask: Task<Void, Never>?

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Init

    init() {}

    deinit {
        // Cancel everything without triggering reconnect.
        shouldReconnect = false
        reconnectTask?.cancel()
        pingTask?.cancel()
        pongTimeoutTask?.cancel()
        connection?.cancel()
        for continuation in subscribers.values {
            continuation.finish()
        }
        subscribers.removeAll()
    }

    // MARK: - Socket Path

    /// Resolves the daemon socket path:
    /// 1. `VELLUM_DAEMON_SOCKET` environment variable (or override dictionary)
    /// 2. `~/.vellum/vellum.sock`
    ///
    /// Accepts an optional environment dictionary for testability.
    static func resolveSocketPath(environment: [String: String]? = nil) -> String {
        let env = environment ?? ProcessInfo.processInfo.environment
        if let envPath = env["VELLUM_DAEMON_SOCKET"], !envPath.trimmingCharacters(in: .whitespaces).isEmpty {
            let trimmed = envPath.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("~/") {
                return NSHomeDirectory() + "/" + String(trimmed.dropFirst(2))
            }
            return trimmed
        }
        return NSHomeDirectory() + "/.vellum/vellum.sock"
    }

    // MARK: - Connect

    /// How long to wait for a connection before giving up.
    private static let connectTimeout: TimeInterval = 5.0

    /// Connect to the daemon socket. If already connected, disconnects first.
    func connect() async throws {
        // Disconnect any existing connection without triggering reconnect.
        disconnectInternal(triggerReconnect: false)

        shouldReconnect = true

        let socketPath = Self.resolveSocketPath()
        log.info("Connecting to daemon socket at \(socketPath)")

        let endpoint = NWEndpoint.unix(path: socketPath)
        let parameters = NWParameters()
        parameters.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()

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
                            self.isConnected = true
                            self.reconnectDelay = 1.0
                            self.startReceiveLoop()
                            self.startPingTimer()
                            checkedContinuation.resume()
                        }

                    case .failed(let error):
                        log.error("Connection failed: \(error.localizedDescription)")
                        self.isConnected = false
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
                        self.stopPingTimer()
                        if !resumed {
                            resumed = true
                            timeoutTask.cancel()
                            checkedContinuation.resume(throwing: NWError.posix(.ECANCELED))
                        }

                    case .waiting(let error):
                        log.warning("Connection waiting: \(error.localizedDescription)")
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

    // MARK: - Send

    /// Send a message to the daemon. Fire-and-forget.
    /// Encodes the message as JSON, appends a newline, and writes to the connection.
    func send<T: Encodable>(_ message: T) throws {
        guard let conn = connection else {
            log.warning("Cannot send: not connected")
            return
        }

        var data = try encoder.encode(message)
        data.append(contentsOf: [0x0A]) // newline byte

        conn.send(content: data, completion: .contentProcessed { error in
            if let error {
                log.error("Send failed: \(error.localizedDescription)")
            }
        })
    }

    // MARK: - Disconnect

    /// Disconnect from the daemon. Stops reconnect and ping timers.
    func disconnect() {
        disconnectInternal(triggerReconnect: false)
    }

    private func disconnectInternal(triggerReconnect: Bool) {
        shouldReconnect = triggerReconnect
        reconnectTask?.cancel()
        reconnectTask = nil
        stopPingTimer()

        if let conn = connection {
            conn.stateUpdateHandler = nil
            conn.cancel()
            connection = nil
        }

        receiveBuffer = Data()
        isConnected = false

        // Finish all subscriber streams so `for await` loops terminate
        // instead of hanging forever on disconnect.
        for continuation in subscribers.values {
            continuation.finish()
        }
        subscribers.removeAll()
    }

    // MARK: - Receive Loop

    private func startReceiveLoop() {
        guard let conn = connection else { return }
        receiveData(on: conn)
    }

    private func receiveData(on conn: NWConnection) {
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
    private func processReceivedData(_ data: Data) {
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
                let lineString = String(data: Data(lineData), encoding: .utf8) ?? "<binary>"
                let prefix = lineString.count > 200 ? String(lineString.prefix(200)) + "..." : lineString
                log.error("Failed to decode server message: \(error.localizedDescription), line: \(prefix)")
            }
        }
    }

    private func handleServerMessage(_ message: ServerMessage) {
        // Handle pong internally.
        if case .pong = message {
            awaitingPong = false
            pongTimeoutTask?.cancel()
            pongTimeoutTask = nil
        }

        // Broadcast to all subscribers.
        for continuation in subscribers.values {
            continuation.yield(message)
        }
    }

    // MARK: - Reconnect

    private func handleUnexpectedDisconnect() {
        disconnectInternal(triggerReconnect: shouldReconnect)
        if shouldReconnect {
            // Re-enable reconnect since disconnectInternal sets it based on the parameter.
            self.shouldReconnect = true
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
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

    // MARK: - Ping / Pong

    private func startPingTimer() {
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

    private func stopPingTimer() {
        pingTask?.cancel()
        pingTask = nil
        pongTimeoutTask?.cancel()
        pongTimeoutTask = nil
        awaitingPong = false
    }

    private func sendPing() {
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
