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

        let timeout = request.timeoutSeconds ?? Self.defaultTimeoutSeconds

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
        // When cdpSessionId is provided, use it to find the target whose `id`
        // matches — this mirrors the Chrome extension's resolveTarget() which
        // uses cdpSessionId for target resolution (NOT as a CDP protocol
        // sessionId). Fall back to the first page target when no cdpSessionId
        // is provided or when no target matches.
        let pageTargets = targets.filter { ($0["type"] as? String) == "page" }
        let selectedTarget: [String: Any]? = {
            if let sessionId = request.cdpSessionId {
                // Match by target id (the Chrome DevTools target identifier)
                if let matched = pageTargets.first(where: { ($0["id"] as? String) == sessionId }) {
                    return matched
                }
                // Fall back to first page target if cdpSessionId doesn't match
                log.warning("cdpSessionId '\(sessionId, privacy: .public)' did not match any target id; falling back to first page target")
            }
            return pageTargets.first
        }()

        guard let target = selectedTarget,
              let wsURL = target["webSocketDebuggerUrl"] as? String else {
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
                // CDP protocol errors are command-level errors (not transport
                // failures), so they are NOT isError=true transport errors.
                // Return them as successful results containing the error info
                // so the backend processes them as CDP responses.
                let errorPayload: [String: Any] = [
                    "error": [
                        "code": code,
                        "message": message
                    ]
                ]
                let jsonData = try? JSONSerialization.data(withJSONObject: errorPayload)
                let jsonString = jsonData.flatMap { String(data: $0, encoding: .utf8) } ?? "{\"error\":{\"code\":\(code),\"message\":\"\(message)\"}}"
                return HostBrowserResultPayload(
                    requestId: request.requestId,
                    content: jsonString,
                    isError: false
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

    /// Send a single CDP command over WebSocket and return the JSON result
    /// string. Opens the connection, sends the command, waits for the
    /// matching response (by `id`), and closes the connection.
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

        // Open WebSocket, send, and wait for response
        return try await withCheckedThrowingContinuation { continuation in
            let session = URLSession(configuration: .default)
            let wsTask = session.webSocketTask(with: endpoint)

            // Guard against double-resuming the continuation. The timeout
            // fires on DispatchQueue.global() while WebSocket callbacks
            // run on URLSession's delegate queue, so `resumed` is accessed
            // from multiple threads and must be synchronized.
            let lock = NSLock()
            var resumed = false
            let resumeOnce: (Result<String, Error>) -> Void = { result in
                lock.lock()
                let alreadyResumed = resumed
                if !alreadyResumed { resumed = true }
                lock.unlock()
                guard !alreadyResumed else { return }
                wsTask.cancel(with: .normalClosure, reason: nil)
                session.invalidateAndCancel()
                continuation.resume(with: result)
            }

            // Timeout
            let timeoutWork = DispatchWorkItem {
                resumeOnce(.failure(CDPError.timeout))
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timeoutWork)

            wsTask.resume()

            // Send the command
            wsTask.send(.string(messageString)) { error in
                if let error {
                    timeoutWork.cancel()
                    resumeOnce(.failure(CDPError.connectionFailed("WebSocket send failed: \(error.localizedDescription)")))
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
                                    timeoutWork.cancel()

                                    // Check for CDP protocol error
                                    if let errorObj = json["error"] as? [String: Any] {
                                        let code = errorObj["code"] as? Int ?? -1
                                        let message = errorObj["message"] as? String ?? "Unknown CDP error"
                                        resumeOnce(.failure(CDPError.protocolError(code: code, message: message)))
                                        return
                                    }

                                    // Return the result portion as JSON string
                                    if let resultObj = json["result"] {
                                        if let resultData = try? JSONSerialization.data(withJSONObject: resultObj),
                                           let resultString = String(data: resultData, encoding: .utf8) {
                                            resumeOnce(.success(resultString))
                                        } else {
                                            resumeOnce(.success("{}"))
                                        }
                                    } else {
                                        resumeOnce(.success("{}"))
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
                            timeoutWork.cancel()
                            resumeOnce(.failure(CDPError.connectionFailed("WebSocket receive failed: \(error.localizedDescription)")))
                        }
                    }
                }
                receiveNext()
            }
        }
    }

    // MARK: - Error Helpers

    /// Build a structured transport error payload with `isError: true` so
    /// the backend error classifier can detect transport failures and trigger
    /// failover. Error codes use the lowercase set recognized by
    /// `classifyHostBrowserError`: `transport_error`, `unreachable`,
    /// `timeout`, `non_loopback`.
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
