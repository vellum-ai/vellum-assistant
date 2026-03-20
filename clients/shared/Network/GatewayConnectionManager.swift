import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GatewayConnectionManager")

/// Manages the gateway connection lifecycle: connect, disconnect,
/// reconfigure, auto-wake, and bearer token updates.
///
/// Owns `HTTPTransport` (health checks) and coordinates with `EventStreamClient`
/// (SSE start/stop). Does NOT own published state — `DaemonStatus` observes
/// this manager's callbacks to update its `@Published` properties.
@MainActor
public final class GatewayConnectionManager {

    // MARK: - Transport

    /// HTTP transport for health checks and host tool execution.
    public var httpTransport: HTTPTransport?

    /// Current daemon connection configuration.
    public private(set) var config: DaemonConfig

    /// Whether a connection attempt is in flight.
    public var isConnecting: Bool = false

    /// Whether the transport has authenticated successfully.
    var isAuthenticated = false

    // MARK: - Auto-Wake

    /// Optional closure invoked when a connection attempt fails because the daemon process
    /// is not alive. The macOS app sets this to call `vellumCli.wake(name:)`.
    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?

    /// Platform identifier for automatic 401 re-bootstrap (e.g. "macos", "ios").
    public var recoveryPlatform: String?

    /// Device identifier for automatic 401 re-bootstrap.
    public var recoveryDeviceId: String?

    #if os(macOS)
    /// Timestamp of the last auto-wake attempt.
    var lastAutoWakeAttempt: Date?
    /// The in-flight auto-wake task.
    var autoWakeTask: Task<Void, Never>?
    #endif

    // MARK: - Callbacks

    /// Called when health-check-driven connection state changes.
    var onConnectionStateChanged: ((_ connected: Bool) -> Void)?

    /// Called when the daemon version changes during a health check.
    var onDaemonVersionChanged: ((_ newVersion: String) -> Void)?

    /// Called when a health check 401 needs to emit an auth error to the UI.
    var onAuthError: ((_ message: ServerMessage) -> Void)?

    // MARK: - Dependencies

    /// Event stream client — ConnectionManager starts/stops SSE and registers conversation IDs.
    private let eventStreamClient: EventStreamClient

    // MARK: - Init

    init(config: DaemonConfig, eventStreamClient: EventStreamClient) {
        self.config = config
        self.eventStreamClient = eventStreamClient
    }

    // MARK: - Connect

    public func connect() async throws {
        try await connectImpl(cancelAutoWake: true)
    }

    func connectImpl(cancelAutoWake: Bool) async throws {
        disconnectInternal(cancelAutoWake: cancelAutoWake)

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

        // Bridge HTTP transport connection state to DaemonStatus via callback.
        transport.onConnectionStateChanged = { [weak self] connected in
            guard let self else { return }
            self.isConnecting = false
            self.onConnectionStateChanged?(connected)
            #if os(macOS)
            if !connected {
                self.autoWakeIfDaemonDied()
            }
            #endif
        }

        // Sync daemon version from health checks.
        transport.onDaemonVersionChanged = { [weak self] newVersion in
            self?.onDaemonVersionChanged?(newVersion)
        }

        // Broadcast auth errors from health check 401 handling.
        transport.onAuthError = { [weak self] message in
            self?.onAuthError?(message)
        }

        self.httpTransport = transport

        // Register the conversation key for host tool filtering
        if !conversationKey.isEmpty {
            eventStreamClient.registerConversationId(conversationKey)
        }

        do {
            try await transport.connect()
            isAuthenticated = true
            isConnecting = false
            log.info("connect: transport connected successfully to \(baseURL, privacy: .public)")

            // Auto-start SSE now that health check passed
            eventStreamClient.startSSE()
        } catch {
            #if os(macOS)
            guard !Task.isCancelled else {
                isConnecting = false
                httpTransport = nil
                log.info("connect: task cancelled — skipping auto-wake")
                throw error
            }

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
                        eventStreamClient.startSSE()
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

    // MARK: - Disconnect

    public func disconnect() {
        disconnectInternal()
    }

    func disconnectInternal(cancelAutoWake: Bool = true) {
        isAuthenticated = false

        #if os(macOS)
        if cancelAutoWake {
            autoWakeTask?.cancel()
            autoWakeTask = nil
        }
        #endif

        httpTransport?.disconnect()
        httpTransport = nil
        // Stop SSE but preserve subscriber streams — consumers start one-shot
        // for-await loops that must survive reconnects and assistant switches.
        eventStreamClient.stopSSE()
    }

    // MARK: - Reconfigure

    /// Reconfigure the transport in place without replacing object identity.
    /// Preserves subscriber references across assistant switches.
    /// Callers must call `connect()` after reconfiguring.
    public func reconfigure(config newConfig: DaemonConfig) {
        #if os(macOS)
        autoWakeTask?.cancel()
        autoWakeTask = nil
        #endif
        disconnect()
        self.config = newConfig
        isAuthenticated = false
        #if os(macOS)
        lastAutoWakeAttempt = nil
        #endif
    }

    // MARK: - Token Update

    /// Push a new bearer token to the active HTTP transport.
    public func updateBearerToken(_ token: String) {
        httpTransport?.updateBearerToken(token)
    }

    // MARK: - Auto-Wake

    #if os(macOS)
    private static let autoWakeCooldown: TimeInterval = 60.0

    private func autoWakeIfDaemonDied() {
        guard let wakeHandler,
              config.transportMetadata.routeMode == .runtimeFlat
        else { return }

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
                try await self.connectImpl(cancelAutoWake: false)
                guard !Task.isCancelled else {
                    log.info("auto-wake: cancelled after connect — abandoning")
                    return
                }
                log.info("auto-wake: reconnect succeeded")
            } catch {
                log.error("auto-wake: failed: \(error)")
            }
            self.autoWakeTask = nil
        }
    }
    #endif

    deinit {
        #if os(macOS)
        autoWakeTask?.cancel()
        #endif
    }
}
