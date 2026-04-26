import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LiveVoiceChannelClient")

// MARK: - Public Types

/// Audio format metadata sent in the live voice start frame.
public struct LiveVoiceChannelAudioFormat: Codable, Sendable, Equatable {
    public let mimeType: String
    public let sampleRate: Int
    public let channels: Int

    public init(mimeType: String, sampleRate: Int, channels: Int) {
        self.mimeType = mimeType
        self.sampleRate = sampleRate
        self.channels = channels
    }

    public static let pcm16kMono = LiveVoiceChannelAudioFormat(
        mimeType: "audio/pcm",
        sampleRate: 16_000,
        channels: 1
    )
}

/// Normalized server events received over the live voice channel WebSocket.
public enum LiveVoiceChannelEvent: Sendable, Equatable {
    case ready(sessionId: String, conversationId: String)
    case sttPartial(text: String, seq: Int)
    case sttFinal(text: String, seq: Int)
    case thinking(turnId: String)
    case assistantTextDelta(text: String, seq: Int)
    case ttsAudio(data: Data, mimeType: String, sampleRate: Int, seq: Int)
    case ttsDone(turnId: String)
    case metrics(LiveVoiceChannelMetrics)
    case archived(conversationId: String, sessionId: String)
}

/// Turn-level latency metrics reported by the assistant.
public struct LiveVoiceChannelMetrics: Sendable, Equatable {
    public let turnId: String
    public let sttMs: Int?
    public let llmFirstDeltaMs: Int?
    public let ttsFirstAudioMs: Int?
    public let totalMs: Int?

    public init(
        turnId: String,
        sttMs: Int?,
        llmFirstDeltaMs: Int?,
        ttsFirstAudioMs: Int?,
        totalMs: Int?
    ) {
        self.turnId = turnId
        self.sttMs = sttMs
        self.llmFirstDeltaMs = llmFirstDeltaMs
        self.ttsFirstAudioMs = ttsFirstAudioMs
        self.totalMs = totalMs
    }
}

/// Describes why a live voice channel session failed.
public enum LiveVoiceChannelFailure: Sendable, Equatable, LocalizedError {
    /// The WebSocket could not be established or unexpectedly lost transport.
    case connectionFailed(message: String)
    /// The gateway or assistant rejected the WebSocket upgrade.
    case connectionRejected(statusCode: Int?)
    /// The server sent an invalid frame or explicit protocol-level error.
    case protocolError(code: String, message: String)
    /// Another live voice session is already active.
    case busy(activeSessionId: String)
    /// The connection or ready handshake timed out.
    case timeout(message: String)
    /// The WebSocket closed with a non-normal close code.
    case abnormalClosure(code: Int, reason: String?)

    public var errorDescription: String? {
        switch self {
        case .connectionFailed(let message):
            return message
        case .connectionRejected(let statusCode):
            if let statusCode {
                return "Live voice connection rejected with status \(statusCode)"
            }
            return "Live voice connection rejected"
        case .protocolError(_, let message):
            return message
        case .busy:
            return "Another live voice session is already active"
        case .timeout(let message):
            return message
        case .abnormalClosure(let code, let reason):
            if let reason, !reason.isEmpty {
                return "Live voice WebSocket closed abnormally (\(code)): \(reason)"
            }
            return "Live voice WebSocket closed abnormally (\(code))"
        }
    }
}

/// Client for the gateway-backed live voice channel WebSocket.
public protocol LiveVoiceChannelClientProtocol: Sendable {
    /// Start a live voice session.
    ///
    /// The assistant resolves STT, LLM, and TTS providers from its own
    /// configuration. Clients only send conversation and audio-shape metadata.
    func start(
        conversationId: String?,
        audioFormat: LiveVoiceChannelAudioFormat,
        onEvent: @escaping @MainActor (LiveVoiceChannelEvent) -> Void,
        onFailure: @escaping @MainActor (LiveVoiceChannelFailure) -> Void
    ) async

    /// Send a binary PCM audio frame.
    func sendAudio(_ data: Data) async

    /// Mark the current push-to-talk segment as released.
    func releasePushToTalk() async

    /// Interrupt assistant speech for barge-in.
    func interrupt() async

    /// End the live voice session gracefully.
    func end() async

    /// Close the WebSocket immediately. Idempotent.
    func close() async
}

// MARK: - Internal Types

enum LiveVoiceChannelSessionState: Sendable, Equatable, Hashable {
    case idle
    case connecting
    case active
    case ending
    case closed
}

enum LiveVoiceChannelFrameDecodeResult: Sendable, Equatable {
    case event(LiveVoiceChannelEvent)
    case failure(LiveVoiceChannelFailure)
}

protocol LiveVoiceChannelWebSocketTask: AnyObject {
    var closeCode: URLSessionWebSocketTask.CloseCode { get }
    var closeReason: Data? { get }
    var response: URLResponse? { get }

    func resume()
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
}

extension URLSessionWebSocketTask: LiveVoiceChannelWebSocketTask {}

// MARK: - Implementation

/// Gateway-backed live voice channel client using `URLSessionWebSocketTask`.
///
/// Create a new instance for each live voice session. The client handles:
/// - Authenticated WebSocket construction via `GatewayHTTPClient.buildWebSocketRequest`
/// - Provider-agnostic JSON control frames
/// - Binary audio frame transmission
/// - Server event decoding, including base64 TTS audio payloads
/// - Clean receive-loop cancellation on explicit end/close
@MainActor
public final class LiveVoiceChannelClient: LiveVoiceChannelClientProtocol {

    static let connectionTimeout: TimeInterval = 10

    private let requestBuilder: ([String: String]?) throws -> URLRequest
    private let webSocketFactory: (URLRequest) -> any LiveVoiceChannelWebSocketTask

    private var state: LiveVoiceChannelSessionState = .idle
    private var webSocketTask: (any LiveVoiceChannelWebSocketTask)?
    private var receiveTask: Task<Void, Never>?
    private var connectionTimeoutTask: Task<Void, Never>?
    private var onEvent: (@MainActor (LiveVoiceChannelEvent) -> Void)?
    private var onFailure: (@MainActor (LiveVoiceChannelFailure) -> Void)?

    public convenience init() {
        self.init(
            requestBuilder: { params in
                try GatewayHTTPClient.buildWebSocketRequest(path: "live-voice", params: params)
            },
            webSocketFactory: { request in
                URLSession.shared.webSocketTask(with: request)
            }
        )
    }

    init(
        requestBuilder: @escaping ([String: String]?) throws -> URLRequest,
        webSocketFactory: @escaping (URLRequest) -> any LiveVoiceChannelWebSocketTask
    ) {
        self.requestBuilder = requestBuilder
        self.webSocketFactory = webSocketFactory
    }

    // MARK: - Lifecycle

    public func start(
        conversationId: String? = nil,
        audioFormat: LiveVoiceChannelAudioFormat = .pcm16kMono,
        onEvent: @escaping @MainActor (LiveVoiceChannelEvent) -> Void,
        onFailure: @escaping @MainActor (LiveVoiceChannelFailure) -> Void
    ) async {
        guard state == .idle else {
            log.warning("LiveVoiceChannelClient.start() called in non-idle state: \(String(describing: self.state))")
            return
        }
        guard Self.isValid(audioFormat: audioFormat) else {
            onFailure(.protocolError(code: "invalid_start", message: "Invalid live voice audio format"))
            return
        }

        self.onEvent = onEvent
        self.onFailure = onFailure
        state = .connecting

        do {
            let params = Self.requestParams(conversationId: conversationId)
            let request = try requestBuilder(params)
            log.info("Opening live voice WebSocket")

            let task = webSocketFactory(request)
            webSocketTask = task
            task.resume()

            startReceiveLoop()
            startConnectionTimeout()

            try await sendStartFrame(conversationId: conversationId, audioFormat: audioFormat)
        } catch {
            log.error("Failed to start live voice WebSocket: \(error.localizedDescription)")
            teardown(failure: .connectionFailed(message: error.localizedDescription), closeCode: .normalClosure)
        }
    }

    public func sendAudio(_ data: Data) async {
        guard state == .active else { return }
        guard let task = webSocketTask else { return }

        do {
            try await task.send(.data(data))
        } catch {
            log.debug("Live voice: failed to send audio frame: \(error.localizedDescription)")
            teardown(failure: .connectionFailed(message: error.localizedDescription), closeCode: .normalClosure)
        }
    }

    public func releasePushToTalk() async {
        await sendControlFrame(type: "ptt_release", allowedStates: [.active])
    }

    public func interrupt() async {
        await sendControlFrame(type: "interrupt", allowedStates: [.active])
    }

    public func end() async {
        guard state == .connecting || state == .active else { return }
        state = .ending
        await sendControlFrame(type: "end", allowedStates: [.ending])
        teardown(failure: nil, closeCode: .normalClosure)
    }

    public func close() async {
        guard state != .closed else { return }
        teardown(failure: nil, closeCode: .normalClosure)
    }

    // MARK: - Request and Frame Encoding

    static func requestParams(conversationId: String?) -> [String: String]? {
        guard let conversationId, !conversationId.isEmpty else { return nil }
        return ["conversationId": conversationId]
    }

    static func encodeStartFrame(conversationId: String?, audioFormat: LiveVoiceChannelAudioFormat) throws -> String {
        struct StartFrame: Encodable {
            let type = "start"
            let conversationId: String?
            let audio: LiveVoiceChannelAudioFormat
        }

        let data = try JSONEncoder().encode(StartFrame(conversationId: conversationId, audio: audioFormat))
        guard let text = String(data: data, encoding: .utf8) else {
            throw LiveVoiceChannelFailure.protocolError(code: "encode_failed", message: "Failed to encode live voice start frame")
        }
        return text
    }

    static func encodeControlFrame(type: String) throws -> String {
        struct ControlFrame: Encodable {
            let type: String
        }

        let data = try JSONEncoder().encode(ControlFrame(type: type))
        guard let text = String(data: data, encoding: .utf8) else {
            throw LiveVoiceChannelFailure.protocolError(code: "encode_failed", message: "Failed to encode live voice control frame")
        }
        return text
    }

    private func sendStartFrame(conversationId: String?, audioFormat: LiveVoiceChannelAudioFormat) async throws {
        guard let task = webSocketTask else { return }
        let text = try Self.encodeStartFrame(conversationId: conversationId, audioFormat: audioFormat)
        try await task.send(.string(text))
    }

    private func sendControlFrame(type: String, allowedStates: Set<LiveVoiceChannelSessionState>) async {
        guard allowedStates.contains(state) else { return }
        guard let task = webSocketTask else { return }

        do {
            let text = try Self.encodeControlFrame(type: type)
            try await task.send(.string(text))
        } catch {
            log.debug("Live voice: failed to send \(type) frame: \(error.localizedDescription)")
            if state != .closed {
                teardown(failure: .connectionFailed(message: error.localizedDescription), closeCode: .normalClosure)
            }
        }
    }

    private static func isValid(audioFormat: LiveVoiceChannelAudioFormat) -> Bool {
        !audioFormat.mimeType.isEmpty && audioFormat.sampleRate > 0 && audioFormat.channels > 0
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
                        self.handleReceiveError(error, task: task)
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
            log.warning("Live voice connection timed out")
            self.teardown(
                failure: .timeout(message: "Connection timed out after \(Int(Self.connectionTimeout))s"),
                closeCode: .normalClosure
            )
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
            parseServerFrame(text)
        case .data(let data):
            guard let text = String(data: data, encoding: .utf8) else {
                teardown(
                    failure: .protocolError(code: "unexpected_binary", message: "Server sent a non-JSON binary frame"),
                    closeCode: .protocolError
                )
                return
            }
            parseServerFrame(text)
        @unknown default:
            teardown(
                failure: .protocolError(code: "unknown_frame", message: "Server sent an unsupported WebSocket frame"),
                closeCode: .protocolError
            )
        }
    }

    /// Parses a JSON server frame and dispatches to the appropriate callback.
    ///
    /// Internal visibility for unit tests.
    func parseServerFrame(_ json: String) {
        switch Self.decodeServerFrame(json) {
        case .event(let event):
            handleServerEvent(event)
        case .failure(let failure):
            teardown(failure: failure, closeCode: closeCode(for: failure))
        }
    }

    static func decodeServerFrame(_ json: String) -> LiveVoiceChannelFrameDecodeResult {
        guard let data = json.data(using: .utf8) else {
            return .failure(.protocolError(code: "invalid_json", message: "Server frame was not valid UTF-8 JSON"))
        }

        struct RawFrame: Decodable {
            let type: String
            let sessionId: String?
            let conversationId: String?
            let activeSessionId: String?
            let text: String?
            let seq: Int?
            let turnId: String?
            let mimeType: String?
            let sampleRate: Int?
            let dataBase64: String?
            let sttMs: Int?
            let llmFirstDeltaMs: Int?
            let ttsFirstAudioMs: Int?
            let totalMs: Int?
            let code: String?
            let message: String?
        }

        let raw: RawFrame
        do {
            raw = try JSONDecoder().decode(RawFrame.self, from: data)
        } catch {
            return .failure(.protocolError(code: "invalid_json", message: "Failed to decode live voice server frame"))
        }

        let seq = raw.seq ?? 0

        switch raw.type {
        case "ready":
            guard let sessionId = raw.sessionId, let conversationId = raw.conversationId else {
                return .failure(.protocolError(code: "invalid_ready", message: "Ready frame missing sessionId or conversationId"))
            }
            return .event(.ready(sessionId: sessionId, conversationId: conversationId))
        case "busy":
            return .failure(.busy(activeSessionId: raw.activeSessionId ?? "unknown"))
        case "stt_partial":
            return .event(.sttPartial(text: raw.text ?? "", seq: seq))
        case "stt_final":
            return .event(.sttFinal(text: raw.text ?? "", seq: seq))
        case "thinking":
            guard let turnId = raw.turnId else {
                return .failure(.protocolError(code: "invalid_thinking", message: "Thinking frame missing turnId"))
            }
            return .event(.thinking(turnId: turnId))
        case "assistant_text_delta":
            return .event(.assistantTextDelta(text: raw.text ?? "", seq: seq))
        case "tts_audio":
            guard
                let mimeType = raw.mimeType,
                let sampleRate = raw.sampleRate,
                let dataBase64 = raw.dataBase64,
                let audio = Data(base64Encoded: dataBase64)
            else {
                return .failure(.protocolError(code: "invalid_tts_audio", message: "TTS audio frame missing or invalid audio data"))
            }
            return .event(.ttsAudio(data: audio, mimeType: mimeType, sampleRate: sampleRate, seq: seq))
        case "tts_done":
            guard let turnId = raw.turnId else {
                return .failure(.protocolError(code: "invalid_tts_done", message: "TTS done frame missing turnId"))
            }
            return .event(.ttsDone(turnId: turnId))
        case "metrics":
            guard let turnId = raw.turnId else {
                return .failure(.protocolError(code: "invalid_metrics", message: "Metrics frame missing turnId"))
            }
            return .event(.metrics(LiveVoiceChannelMetrics(
                turnId: turnId,
                sttMs: raw.sttMs,
                llmFirstDeltaMs: raw.llmFirstDeltaMs,
                ttsFirstAudioMs: raw.ttsFirstAudioMs,
                totalMs: raw.totalMs
            )))
        case "archived":
            guard let conversationId = raw.conversationId, let sessionId = raw.sessionId else {
                return .failure(.protocolError(code: "invalid_archived", message: "Archived frame missing conversationId or sessionId"))
            }
            return .event(.archived(conversationId: conversationId, sessionId: sessionId))
        case "error":
            let code = raw.code ?? "server_error"
            let message = raw.message ?? "Live voice session failed"
            return .failure(.protocolError(code: code, message: message))
        default:
            return .failure(.protocolError(code: "unknown_type", message: "Unknown live voice server frame type: \(raw.type)"))
        }
    }

    private func handleServerEvent(_ event: LiveVoiceChannelEvent) {
        switch event {
        case .ready:
            guard state == .connecting else {
                log.debug("Live voice: ready event in non-connecting state")
                return
            }
            cancelConnectionTimeout()
            state = .active
            onEvent?(event)
        default:
            onEvent?(event)
        }
    }

    // MARK: - Error Handling

    private func handleReceiveError(_ error: Error, task: any LiveVoiceChannelWebSocketTask) {
        let nsError = error as NSError

        if let statusCode = rejectionStatusCode(from: task) {
            log.warning("Live voice WebSocket rejected with status \(statusCode)")
            teardown(failure: .connectionRejected(statusCode: statusCode), closeCode: .normalClosure)
            return
        }

        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorTimedOut:
                log.warning("Live voice WebSocket timed out")
                teardown(failure: .timeout(message: "WebSocket connection timed out"), closeCode: .normalClosure)
                return
            case NSURLErrorBadServerResponse:
                log.warning("Live voice WebSocket rejected without status")
                teardown(failure: .connectionRejected(statusCode: nil), closeCode: .normalClosure)
                return
            case NSURLErrorCancelled:
                teardown(failure: nil, closeCode: .normalClosure)
                return
            default:
                break
            }
        }

        if task.closeCode == .normalClosure {
            teardown(failure: nil, closeCode: .normalClosure)
            return
        }

        if let failure = abnormalClosureFailure(from: task) {
            teardown(failure: failure, closeCode: .normalClosure)
            return
        }

        log.warning("Live voice receive error: \(error.localizedDescription)")
        teardown(failure: .connectionFailed(message: error.localizedDescription), closeCode: .normalClosure)
    }

    private func rejectionStatusCode(from task: any LiveVoiceChannelWebSocketTask) -> Int? {
        guard let http = task.response as? HTTPURLResponse else { return nil }
        guard http.statusCode != 101 else { return nil }
        return http.statusCode
    }

    private func abnormalClosureFailure(from task: any LiveVoiceChannelWebSocketTask) -> LiveVoiceChannelFailure? {
        let closeCode = task.closeCode
        guard closeCode != .invalid, closeCode != .normalClosure else { return nil }
        let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
        return .abnormalClosure(code: closeCode.rawValue, reason: reason)
    }

    private func closeCode(for failure: LiveVoiceChannelFailure) -> URLSessionWebSocketTask.CloseCode {
        switch failure {
        case .protocolError:
            return .protocolError
        case .busy:
            return .normalClosure
        case .connectionFailed, .connectionRejected, .timeout, .abnormalClosure:
            return .normalClosure
        }
    }

    // MARK: - Teardown

    /// Clean up all resources. If `failure` is non-nil, reports it to the
    /// failure callback. Idempotent.
    private func teardown(failure: LiveVoiceChannelFailure?, closeCode: URLSessionWebSocketTask.CloseCode) {
        guard state != .closed else { return }
        state = .closed

        cancelConnectionTimeout()
        receiveTask?.cancel()
        receiveTask = nil

        webSocketTask?.cancel(with: closeCode, reason: nil)
        webSocketTask = nil

        if let failure {
            onFailure?(failure)
        }

        onEvent = nil
        onFailure = nil
    }

    deinit {
        connectionTimeoutTask?.cancel()
        receiveTask?.cancel()
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
    }
}
