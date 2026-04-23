import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HostBrowserExecutor")

/// Executes `host_browser_request` envelopes by connecting to a local Chrome
/// DevTools Protocol (CDP) endpoint and sending a single CDP command.
///
/// Only loopback debugging endpoints are permitted (`localhost`, `127.0.0.1`,
/// `::1`) to prevent the client from being used as an open proxy to arbitrary
/// hosts. Non-loopback endpoints are rejected with a structured transport error
/// so the backend error classifier can trigger failover.
///
/// Lifecycle:
/// - `execute(_:using:)` — runs the full attach flow (endpoint discovery,
///   target/session selection, command send, result serialization) and posts
///   the result back through `HostProxyClient.postBrowserResult`.
/// - `cancel(_:)` — marks a request as cancelled so in-flight work is aborted
///   and the result POST is suppressed.
///
/// Thread safety: All public entry points are `@MainActor`. In-flight tasks
/// are tracked in `inFlightTasks` for cancellation support.
@MainActor
public final class HostBrowserExecutor {

    /// Default CDP debugging port when no explicit endpoint is provided.
    private static let defaultCDPPort: Int = 9222

    /// Default timeout for CDP commands when the request does not specify one.
    private static let defaultTimeoutSeconds: Double = 30

    /// Loopback hosts that are permitted for CDP connections.
    private static let allowedLoopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]

    /// In-flight execution tasks keyed by request ID, for cancel support.
    private var inFlightTasks: [String: Task<Void, Never>] = [:]

    /// Request IDs that have been cancelled. Entries are consumed on first
    /// check and swept after 30 seconds.
    private var cancelledRequestIds: [String: Date] = [:]

    private let proxyClient: any HostProxyClientProtocol

    public init(proxyClient: any HostProxyClientProtocol = HostProxyClient()) {
        self.proxyClient = proxyClient
    }

    // MARK: - Public API

    /// Execute a host browser request: discover the CDP endpoint, send the
    /// command, and post the result back to the daemon.
    public func execute(_ request: HostBrowserRequest) {
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.inFlightTasks.removeValue(forKey: request.requestId) }

            // Pre-flight cancellation check
            if self.consumeCancelled(request.requestId) {
                log.debug("Host browser skipped (pre-cancelled) — requestId=\(request.requestId, privacy: .public)")
                return
            }

            let result = await self.run(request)

            // Suppress stale POST if cancelled during execution
            if self.consumeCancelled(request.requestId) {
                log.debug("Host browser result suppressed (cancelled) — requestId=\(request.requestId, privacy: .public)")
                return
            }

            guard !Task.isCancelled else {
                log.debug("Host browser task cancelled — requestId=\(request.requestId, privacy: .public)")
                return
            }

            _ = await self.proxyClient.postBrowserResult(result)
        }
        inFlightTasks[request.requestId] = task
    }

    /// Cancel an in-flight host browser request: mark it cancelled and cancel
    /// the Swift Task so in-flight network calls are interrupted.
    ///
    /// Cancellation is cooperative — the in-flight `sendCDPCommand` WebSocket
    /// connection is torn down immediately when the Task is cancelled, so
    /// the result is available (and suppressed) without waiting for timeout.
    public func cancel(_ requestId: String) {
        markCancelled(requestId)
        if let task = inFlightTasks.removeValue(forKey: requestId) {
            task.cancel()
        }
        log.info("Cancelling host browser — requestId=\(requestId, privacy: .public)")
    }

    // MARK: - Cancellation Tracking

    private func markCancelled(_ requestId: String) {
        let now = Date()
        cancelledRequestIds[requestId] = now
        // Sweep entries older than 30 seconds
        cancelledRequestIds = cancelledRequestIds.filter { now.timeIntervalSince($0.value) < 30 }
    }

    private func consumeCancelled(_ requestId: String) -> Bool {
        cancelledRequestIds.removeValue(forKey: requestId) != nil
    }

    // MARK: - Execution

    /// Run the full CDP command flow and return the result payload. This is
    /// the core logic that does not interact with the proxy client — separated
    /// for testability.
    func run(_ request: HostBrowserRequest) async -> HostBrowserResultPayload {
        // Resolve the CDP endpoint URL from the request. Default to
        // localhost:9222 when no explicit endpoint is provided.
        let host = "localhost"
        let port = Self.defaultCDPPort

        // Validate loopback — only allow connections to localhost / 127.0.0.1 / ::1
        guard Self.allowedLoopbackHosts.contains(host.lowercased()) else {
            return Self.transportError(
                requestId: request.requestId,
                code: "non_loopback",
                message: "CDP endpoint host '\(host)' is not a loopback address. Only localhost, 127.0.0.1, and ::1 are permitted."
            )
        }

        // Guard against values that would trap `UInt64(timeout * 1e9)` in
        // `sendCDPCommand` — `timeoutSeconds` is decoded from JSON without range
        // validation, so negatives, NaN, or ±infinity can reach this path.
        let rawTimeout = request.timeoutSeconds ?? Self.defaultTimeoutSeconds
        let timeout: TimeInterval = (rawTimeout.isFinite && rawTimeout >= 0 && rawTimeout <= 18_000_000_000)
            ? rawTimeout
            : Self.defaultTimeoutSeconds

        // Step 1: Discover available targets via /json/list
        let targetsURL = URL(string: "http://\(host):\(port)/json/list")!
        let targets: [[String: Any]]
        do {
            targets = try await fetchJSON(url: targetsURL, timeout: timeout)
        } catch {
            return Self.transportError(
                requestId: request.requestId,
                code: "unreachable",
                message: "Failed to connect to Chrome DevTools at \(host):\(port): \(error.localizedDescription)"
            )
        }

        // Step 2: Select a page target.
        // When cdpSessionId is provided, it is authoritative — only the target
        // whose `id` matches is used. If no target matches, the request fails
        // closed with a structured error (cdp_session_not_found) instead of
        // silently running on an unrelated tab. This mirrors the Chrome
        // extension's resolveTarget() which uses cdpSessionId for target
        // resolution (NOT as a CDP protocol sessionId).
        // When no cdpSessionId is provided, fall back to the first page target.
        let pageTargets = targets.filter { ($0["type"] as? String) == "page" }
        let selectedTarget: [String: Any]? = {
            if let sessionId = request.cdpSessionId {
                if let matched = pageTargets.first(where: { ($0["id"] as? String) == sessionId }) {
                    return matched
                }
                // Fail closed: cdpSessionId was authoritative but no target matched.
                // Do NOT fall back to first page target — that would run the command
                // on the wrong tab.
                log.warning("cdpSessionId '\(sessionId, privacy: .public)' did not match any target id; failing closed")
                return nil
            }
            // No cdpSessionId provided — fall back to first page target (existing behavior).
            return pageTargets.first
        }()

        guard let target = selectedTarget,
              let wsURL = target["webSocketDebuggerUrl"] as? String else {
            if let sessionId = request.cdpSessionId {
                // cdpSessionId was provided but did not match any target — fail closed
                // with a specific error code so the backend can distinguish this from
                // "Chrome is not running".
                return Self.transportError(
                    requestId: request.requestId,
                    code: "cdp_session_not_found",
                    message: "cdpSessionId '\(sessionId)' did not match any page target in /json/list. The target may have been closed or navigated."
                )
            }
            return Self.transportError(
                requestId: request.requestId,
                code: "unreachable",
                message: "No debuggable page target found at \(host):\(port). Ensure Chrome is running with --remote-debugging-port=\(port)."
            )
        }

        // Step 3: Connect via WebSocket and send the CDP command
        guard let wsEndpoint = URL(string: wsURL) else {
            return Self.transportError(
                requestId: request.requestId,
                code: "transport_error",
                message: "Chrome returned an invalid WebSocket URL: \(wsURL)"
            )
        }

        // Validate that the WebSocket URL also points to a loopback address.
        // A process on localhost:9222 could return a non-loopback wsURL to
        // redirect the client to an arbitrary remote host.
        guard let wsHost = wsEndpoint.host, Self.allowedLoopbackHosts.contains(wsHost.lowercased()) else {
            let wsHostDisplay = wsEndpoint.host ?? "<none>"
            return Self.transportError(
                requestId: request.requestId,
                code: "non_loopback",
                message: "WebSocket URL host '\(wsHostDisplay)' is not a loopback address. Only localhost, 127.0.0.1, and ::1 are permitted."
            )
        }

        do {
            // cdpSessionId is used for target resolution above — it must NOT
            // be forwarded as a CDP flat-session sessionId in the WebSocket
            // message. Doing so causes Chrome to look up a non-existent
            // session and fail with "Session with given id not found".
            let result = try await sendCDPCommand(
                endpoint: wsEndpoint,
                method: request.cdpMethod,
                params: request.cdpParams,
                sessionId: nil,
                timeout: timeout
            )
            return HostBrowserResultPayload(
                requestId: request.requestId,
                content: result,
                isError: false
            )
        } catch is CancellationError {
            return Self.transportError(
                requestId: request.requestId,
                code: "cancelled",
                message: "CDP command cancelled"
            )
        } catch let error as CDPError {
            switch error {
            case .timeout:
                return Self.transportError(
                    requestId: request.requestId,
                    code: "timeout",
                    message: "CDP command '\(request.cdpMethod)' timed out after \(timeout)s"
                )
            case .connectionFailed(let reason):
                return Self.transportError(
                    requestId: request.requestId,
                    code: "transport_error",
                    message: "WebSocket connection to Chrome DevTools failed: \(reason)"
                )
            case .protocolError(let code, let message):
                // CDP protocol errors are command-level failures. The backend
                // ExtensionCdpClient checks isError to enter the error-handling
                // branch, so this must be true. The content is a flat object
                // with code and message at the top level so
                // classifyHostBrowserError can read the code field directly.
                let errorPayload: [String: Any] = [
                    "code": code,
                    "message": message
                ]
                let jsonData = try? JSONSerialization.data(withJSONObject: errorPayload)
                let jsonString = jsonData.flatMap { String(data: $0, encoding: .utf8) } ?? "{\"code\":\(code),\"message\":\"\(message)\"}"
                return HostBrowserResultPayload(
                    requestId: request.requestId,
                    content: jsonString,
                    isError: true
                )
            }
        } catch {
            return Self.transportError(
                requestId: request.requestId,
                code: "transport_error",
                message: "Unexpected error executing CDP command: \(error.localizedDescription)"
            )
        }
    }

    // MARK: - CDP Communication

    /// Fetch JSON from a URL with a timeout. Returns an array of dictionaries.
    private func fetchJSON(url: URL, timeout: TimeInterval) async throws -> [[String: Any]] {
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = timeout

        let (data, response) = try await URLSession.shared.data(for: urlRequest)

        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw CDPError.connectionFailed("HTTP \(statusCode) from \(url.absoluteString)")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw CDPError.connectionFailed("Invalid JSON response from \(url.absoluteString)")
        }

        return json
    }

    /// Thread-safe mutable state shared between the continuation body and
    /// the `onCancel` closure of `withTaskCancellationHandler`. The cancel
    /// handler runs concurrently (or even before the body starts if the
    /// task is already cancelled), so every field is guarded by `lock`.
    private final class CancelState: @unchecked Sendable {
        let lock = NSLock()
        var resumed = false
        var wsTask: URLSessionWebSocketTask?
        var session: URLSession?
        var timeoutWork: Task<Void, Never>?
        var continuation: CheckedContinuation<String, Error>?

        /// Resume the continuation exactly once with a normal result,
        /// closing the WebSocket cleanly.
        func resumeOnce(with result: Result<String, Error>) {
            lock.lock()
            let alreadyResumed = resumed
            if !alreadyResumed { resumed = true }
            lock.unlock()
            guard !alreadyResumed else { return }
            wsTask?.cancel(with: .normalClosure, reason: nil)
            session?.invalidateAndCancel()
            timeoutWork?.cancel()
            continuation?.resume(with: result)
        }

        /// Tear down the WebSocket immediately for cooperative cancellation,
        /// resuming the continuation with `CancellationError`.
        func teardown() {
            lock.lock()
            let alreadyResumed = resumed
            if !alreadyResumed { resumed = true }
            lock.unlock()
            guard !alreadyResumed else { return }
            wsTask?.cancel(with: .goingAway, reason: nil)
            session?.invalidateAndCancel()
            timeoutWork?.cancel()
            continuation?.resume(throwing: CancellationError())
        }
    }

    /// Send a single CDP command over WebSocket and return the JSON result
    /// string. Opens the connection, sends the command, waits for the
    /// matching response (by `id`), and closes the connection.
    ///
    /// Cancellation is cooperative: when the enclosing Task is cancelled,
    /// the WebSocket and URLSession are torn down immediately and the
    /// continuation resumes with `CancellationError()`. This ensures that
    /// `cancel(requestId:)` takes effect promptly instead of waiting for
    /// the full timeout or a WebSocket receive to complete.
    private func sendCDPCommand(
        endpoint: URL,
        method: String,
        params: [String: AnyCodable]?,
        sessionId: String?,
        timeout: TimeInterval
    ) async throws -> String {
        // Build the CDP JSON-RPC message
        let commandId = 1
        var message: [String: Any] = [
            "id": commandId,
            "method": method
        ]
        if let params {
            message["params"] = params.mapValues { $0.value as Any }
        }
        if let sessionId {
            message["sessionId"] = sessionId
        }

        let messageData = try JSONSerialization.data(withJSONObject: message)
        guard let messageString = String(data: messageData, encoding: .utf8) else {
            throw CDPError.connectionFailed("Failed to serialize CDP command")
        }

        // CancelState is created before withTaskCancellationHandler so the
        // onCancel closure can reference it even if the task is already
        // cancelled when the handler is entered.
        let state = CancelState()

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.lock.lock()
                state.continuation = continuation
                let alreadyResumed = state.resumed
                state.lock.unlock()

                // If teardown() already fired (task was cancelled before we
                // got here), it set `resumed = true` but `continuation` was
                // still nil so it could not resume. Resume here instead.
                if alreadyResumed {
                    continuation.resume(throwing: CancellationError())
                    return
                }

                let session = URLSession(configuration: .default)
                let wsTask = session.webSocketTask(with: endpoint)
                let timeoutTask = Task {
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    state.resumeOnce(with: .failure(CDPError.timeout))
                }

                state.lock.lock()
                state.session = session
                state.wsTask = wsTask
                state.timeoutWork = timeoutTask
                let tornDownDuringGap = state.resumed
                state.lock.unlock()

                // If teardown() fired between the first `alreadyResumed`
                // check and storing the resources above, it called cancel/
                // invalidate on nil values and left these just-created
                // resources dangling. Clean them up now and bail out —
                // teardown() already resumed the continuation.
                if tornDownDuringGap {
                    wsTask.cancel(with: .goingAway, reason: nil)
                    session.invalidateAndCancel()
                    timeoutTask.cancel()
                    return
                }

                wsTask.resume()

                // Send the command
                wsTask.send(.string(messageString)) { error in
                    if let error {
                        state.resumeOnce(with: .failure(CDPError.connectionFailed("WebSocket send failed: \(error.localizedDescription)")))
                        return
                    }

                    // Listen for the response
                    func receiveNext() {
                        wsTask.receive { result in
                            switch result {
                            case .success(let wsMessage):
                                switch wsMessage {
                                case .string(let text):
                                    // Parse to check if this is our response (matching id)
                                    if let data = text.data(using: .utf8),
                                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                                       let responseId = json["id"] as? Int,
                                       responseId == commandId {
                                        // Check for CDP protocol error
                                        if let errorObj = json["error"] as? [String: Any] {
                                            let code = errorObj["code"] as? Int ?? -1
                                            let message = errorObj["message"] as? String ?? "Unknown CDP error"
                                            state.resumeOnce(with: .failure(CDPError.protocolError(code: code, message: message)))
                                            return
                                        }

                                        // Return the result portion as JSON string
                                        if let resultObj = json["result"] {
                                            if let resultData = try? JSONSerialization.data(withJSONObject: resultObj),
                                               let resultString = String(data: resultData, encoding: .utf8) {
                                                state.resumeOnce(with: .success(resultString))
                                            } else {
                                                state.resumeOnce(with: .success("{}"))
                                            }
                                        } else {
                                            state.resumeOnce(with: .success("{}"))
                                        }
                                    } else {
                                        // Not our response — keep listening (events, other messages)
                                        receiveNext()
                                    }
                                case .data:
                                    // Binary frames are not expected from CDP
                                    receiveNext()
                                @unknown default:
                                    receiveNext()
                                }
                            case .failure(let error):
                                state.resumeOnce(with: .failure(CDPError.connectionFailed("WebSocket receive failed: \(error.localizedDescription)")))
                            }
                        }
                    }
                    receiveNext()
                }
            }
        } onCancel: {
            // Cooperative cancellation: immediately tear down the WS and
            // resume the continuation so the caller doesn't wait for
            // timeout/receive completion.
            state.teardown()
        }
    }

    // MARK: - Error Helpers

    /// Build a structured transport error payload with `isError: true` so
    /// the backend error classifier can detect transport failures and trigger
    /// failover. Error codes use the lowercase set recognized by
    /// `classifyHostBrowserError`: `transport_error`, `unreachable`,
    /// `timeout`, `non_loopback`, `cdp_session_not_found`.
    static func transportError(
        requestId: String,
        code: String,
        message: String
    ) -> HostBrowserResultPayload {
        let errorJSON: [String: Any] = [
            "code": code,
            "message": message
        ]
        let jsonData = (try? JSONSerialization.data(withJSONObject: errorJSON)) ?? Data()
        let content = String(data: jsonData, encoding: .utf8) ?? "{\"code\":\"\(code)\",\"message\":\"\(message)\"}"
        log.error("Host browser transport error: \(code) — \(message) (requestId=\(requestId, privacy: .public))")
        return HostBrowserResultPayload(
            requestId: requestId,
            content: content,
            isError: true
        )
    }

    // MARK: - Errors

    enum CDPError: Error {
        case timeout
        case connectionFailed(String)
        case protocolError(code: Int, message: String)
    }
}
