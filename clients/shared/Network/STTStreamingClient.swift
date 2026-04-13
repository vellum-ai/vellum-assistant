import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "STTStreamingClient")

// MARK: - Server Event Types

/// Normalized server events received over the STT streaming WebSocket.
///
/// The discriminated `type` field matches the runtime session orchestrator's
/// event protocol (`ready`, `partial`, `final`, `error`, `closed`), with a
/// `seq` field for per-session ordering guarantees.
public enum STTStreamEvent: Sendable, Equatable {
    /// The server is ready to accept audio frames. Contains the resolved
    /// provider identifier.
    case ready(provider: String)
    /// An interim (partial) transcript that may be revised by subsequent events.
    case partial(text: String, seq: Int)
    /// A committed (final) transcript segment that will not be revised.
    case final(text: String, seq: Int)
    /// An error occurred during the streaming session.
    case error(category: String, message: String, seq: Int)
    /// The streaming session has closed — no more events will be emitted.
    case closed(seq: Int)
}

// MARK: - Session State

/// Internal lifecycle state for the streaming session.
enum STTStreamSessionState: Sendable {
    /// Session created, WebSocket not yet connected.
    case idle
    /// WebSocket connected, waiting for `ready` from server.
    case connecting
    /// Server sent `ready`, session is accepting audio.
    case active
    /// Client sent `stop`, waiting for server to flush finals.
    case stopping
    /// Session fully closed (terminal state).
    case closed
}

// MARK: - Failure Reason

/// Describes why a streaming session failed to establish or was terminated.
///
/// Callers use this to decide whether to fall back to batch STT. All cases
/// represent non-retryable conditions within the scope of the current session.
public enum STTStreamFailure: Sendable, Equatable {
    /// The WebSocket connection could not be established (network error,
    /// DNS failure, TLS handshake error, etc.).
    case connectionFailed(message: String)
    /// The server rejected the connection (non-101 upgrade response).
    case rejected(statusCode: Int)
    /// The server reported that the provider does not support streaming.
    case unsupportedProvider(message: String)
    /// The server reported a provider-side error during the session.
    case providerError(category: String, message: String)
    /// The session timed out (idle timeout or connection timeout).
    case timeout(message: String)
    /// The WebSocket was closed abnormally (unexpected close code).
    case abnormalClosure(code: Int, reason: String?)
}

// MARK: - Protocol

/// Client for real-time STT streaming over the gateway WebSocket.
///
/// Implementations manage the lifecycle of a single streaming session:
/// connect, send audio chunks, receive partial/final transcripts, and
/// handle close/error events.
public protocol STTStreamingClientProtocol: Sendable {
    /// Start a streaming STT session with the given provider and audio format.
    ///
    /// - Parameters:
    ///   - provider: STT provider identifier (e.g. `"deepgram"`, `"google-gemini"`).
    ///   - mimeType: MIME type of the audio being streamed (e.g. `"audio/pcm"`).
    ///   - sampleRate: Sample rate in Hz (e.g. `16000`). Optional.
    ///   - onEvent: Callback invoked on the main actor for each server event.
    ///   - onFailure: Callback invoked on the main actor when the session fails
    ///     or terminates abnormally. After this fires, the session is closed and
    ///     callers should fall back to batch STT.
    func start(
        provider: String,
        mimeType: String,
        sampleRate: Int?,
        onEvent: @escaping @MainActor (STTStreamEvent) -> Void,
        onFailure: @escaping @MainActor (STTStreamFailure) -> Void
    ) async

    /// Send a chunk of PCM audio data to the streaming session.
    ///
    /// Must only be called after receiving a `.ready` event. Calls before
    /// ready or after stop/close are silently dropped.
    func sendAudio(_ data: Data) async

    /// Signal that the client has finished recording. The server may emit
    /// additional final events before sending `closed`.
    func stop() async

    /// Forcibly close the session, tearing down the WebSocket connection.
    /// Idempotent — safe to call multiple times.
    func close() async
}

// MARK: - Implementation

/// Gateway-backed STT streaming client using `URLSessionWebSocketTask`.
///
/// Manages a single WebSocket session per instance. Create a new instance
/// for each recording session. The client handles:
/// - Authenticated WebSocket connection via `GatewayHTTPClient.buildWebSocketRequest`
/// - Binary audio frame transmission
/// - JSON event parsing for ready/partial/final/error/closed events
/// - Graceful and abnormal close handling with fallback-friendly failure reporting
@MainActor
public final class STTStreamingClient: STTStreamingClientProtocol {

    /// Timeout for the initial WebSocket connection handshake.
    static let connectionTimeout: TimeInterval = 10

    private var state: STTStreamSessionState = .idle
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var connectionTimeoutTask: Task<Void, Never>?
    private var onEvent: (@MainActor (STTStreamEvent) -> Void)?
    private var onFailure: (@MainActor (STTStreamFailure) -> Void)?

    nonisolated public init() {}

    // MARK: - Lifecycle

    public func start(
        provider: String,
        mimeType: String,
        sampleRate: Int?,
        onEvent: @escaping @MainActor (STTStreamEvent) -> Void,
        onFailure: @escaping @MainActor (STTStreamFailure) -> Void
    ) async {
        guard state == .idle else {
            log.warning("STTStreamingClient.start() called in non-idle state: \(String(describing: self.state))")
            return
        }

        self.onEvent = onEvent
        self.onFailure = onFailure
        self.state = .connecting

        // Build query parameters for the WebSocket URL.
        var params: [String: String] = [
            "provider": provider,
            "mimeType": mimeType,
        ]
        if let sampleRate {
            params["sampleRate"] = String(sampleRate)
        }

        do {
            let request = try GatewayHTTPClient.buildWebSocketRequest(
                path: "stt/stream",
                params: params
            )
            log.info("Opening STT stream WebSocket: provider=\(provider), mimeType=\(mimeType), sampleRate=\(sampleRate.map(String.init) ?? "nil")")

            let task = URLSession.shared.webSocketTask(with: request)
            self.webSocketTask = task
            task.resume()

            // Start the receive loop to process server events.
            startReceiveLoop()

            // Start a connection timeout that fires if we don't receive
            // a `ready` event within the timeout window.
            startConnectionTimeout()

        } catch {
            log.error("Failed to build STT stream WebSocket request: \(error.localizedDescription)")
            state = .closed
            onFailure(.connectionFailed(message: error.localizedDescription))
        }
    }

    public func sendAudio(_ data: Data) async {
        guard state == .active else { return }
        guard let task = webSocketTask else { return }

        do {
            try await task.send(.data(data))
        } catch {
            log.debug("STT stream: failed to send audio frame: \(error.localizedDescription)")
        }
    }

    public func stop() async {
        guard state == .active else { return }
        state = .stopping

        guard let task = webSocketTask else { return }

        // Send a JSON stop event to signal end of recording.
        let stopMessage = #"{"type":"stop"}"#
        do {
            try await task.send(.string(stopMessage))
            log.info("STT stream: sent stop event")
        } catch {
            log.debug("STT stream: failed to send stop event: \(error.localizedDescription)")
        }
    }

    public func close() async {
        guard state != .closed else { return }
        teardown(failure: nil)
    }

    // MARK: - Receive Loop

    private func startReceiveLoop() {
        receiveTask = Task { @MainActor [weak self] in
            guard let self else { return }

            while !Task.isCancelled, self.state != .closed {
                guard let task = self.webSocketTask else { break }

                do {
                    let message = try await task.receive()
                    self.handleWebSocketMessage(message)
                } catch {
                    if self.state != .closed {
                        self.handleReceiveError(error)
                    }
                    break
                }
            }
        }
    }

    // MARK: - Connection Timeout

    private func startConnectionTimeout() {
        connectionTimeoutTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(Self.connectionTimeout * 1_000_000_000))
            } catch {
                return
            }
            guard let self, self.state == .connecting else { return }
            log.warning("STT stream connection timed out")
            self.teardown(failure: .timeout(message: "Connection timed out after \(Int(Self.connectionTimeout))s"))
        }
    }

    private func cancelConnectionTimeout() {
        connectionTimeoutTask?.cancel()
        connectionTimeoutTask = nil
    }

    // MARK: - Message Handling

    private func handleWebSocketMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            parseServerEvent(text)
        case .data(let data):
            // Server events should be JSON text frames, but handle data
            // frames defensively.
            if let text = String(data: data, encoding: .utf8) {
                parseServerEvent(text)
            }
        @unknown default:
            break
        }
    }

    /// Parses a JSON server event and dispatches to the appropriate callback.
    ///
    /// Internal visibility for testability.
    func parseServerEvent(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }

        struct RawEvent: Decodable {
            let type: String
            let text: String?
            let category: String?
            let message: String?
            let provider: String?
            let seq: Int?
        }

        guard let raw = try? JSONDecoder().decode(RawEvent.self, from: data) else {
            log.debug("STT stream: failed to decode server event")
            return
        }

        let seq = raw.seq ?? 0

        switch raw.type {
        case "ready":
            handleReadyEvent(provider: raw.provider ?? "unknown")
        case "partial":
            onEvent?(.partial(text: raw.text ?? "", seq: seq))
        case "final":
            onEvent?(.final(text: raw.text ?? "", seq: seq))
        case "error":
            let category = raw.category ?? "provider-error"
            let message = raw.message ?? "Unknown error"
            log.warning("STT stream server error: category=\(category), message=\(message)")
            onEvent?(.error(category: category, message: message, seq: seq))
        case "closed":
            log.info("STT stream server sent closed event")
            onEvent?(.closed(seq: seq))
            teardown(failure: nil)
        default:
            log.debug("STT stream: unknown event type: \(raw.type)")
        }
    }

    private func handleReadyEvent(provider: String) {
        guard state == .connecting else {
            log.debug("STT stream: ready event in non-connecting state")
            return
        }
        cancelConnectionTimeout()
        state = .active
        log.info("STT stream ready: provider=\(provider)")
        onEvent?(.ready(provider: provider))
    }

    // MARK: - Error Handling

    private func handleReceiveError(_ error: Error) {
        let nsError = error as NSError

        // URLSessionWebSocketTask reports close codes via URLError.
        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorTimedOut:
                log.warning("STT stream timed out")
                teardown(failure: .timeout(message: "WebSocket connection timed out"))
                return
            case NSURLErrorCancelled:
                // Task was cancelled — expected during teardown.
                teardown(failure: nil)
                return
            default:
                break
            }
        }

        log.warning("STT stream receive error: \(error.localizedDescription)")
        teardown(failure: .connectionFailed(message: error.localizedDescription))
    }

    // MARK: - Teardown

    /// Clean up all resources. If `failure` is non-nil, reports it to the
    /// failure callback. Idempotent — safe to call multiple times.
    private func teardown(failure: STTStreamFailure?) {
        guard state != .closed else { return }
        state = .closed

        cancelConnectionTimeout()
        receiveTask?.cancel()
        receiveTask = nil

        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil

        if let failure {
            onFailure?(failure)
        }

        onEvent = nil
        onFailure = nil
    }

    deinit {
        // Cancel tasks — deinit cannot call async teardown, but cancelling
        // the tasks is sufficient to prevent dangling work.
        connectionTimeoutTask?.cancel()
        receiveTask?.cancel()
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
    }
}
