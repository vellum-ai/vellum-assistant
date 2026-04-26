import Foundation
import XCTest

@testable import VellumAssistantShared

@MainActor
final class LiveVoiceChannelClientTests: XCTestCase {

    // MARK: - Request and Client Frames

    func testRequestParamsOnlyIncludeConversationId() {
        XCTAssertNil(LiveVoiceChannelClient.requestParams(conversationId: nil))
        XCTAssertNil(LiveVoiceChannelClient.requestParams(conversationId: ""))
        XCTAssertEqual(
            LiveVoiceChannelClient.requestParams(conversationId: "conv-123"),
            ["conversationId": "conv-123"]
        )
    }

    func testStartFrameOmitsProviderCredentialsAndProviderIds() throws {
        let frame = try LiveVoiceChannelClient.encodeStartFrame(
            conversationId: "conv-123",
            audioFormat: LiveVoiceChannelAudioFormat(mimeType: "audio/pcm", sampleRate: 16_000, channels: 1)
        )
        let json = try decodeJSONObject(frame)
        let audio = try XCTUnwrap(json["audio"] as? [String: Any])

        XCTAssertEqual(json["type"] as? String, "start")
        XCTAssertEqual(json["conversationId"] as? String, "conv-123")
        XCTAssertEqual(audio["mimeType"] as? String, "audio/pcm")
        XCTAssertEqual(audio["sampleRate"] as? Int, 16_000)
        XCTAssertEqual(audio["channels"] as? Int, 1)

        let serialized = try JSONSerialization.data(withJSONObject: json)
        let text = String(data: serialized, encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains("provider"))
        XCTAssertFalse(text.contains("credential"))
        XCTAssertFalse(text.contains("apiKey"))
    }

    func testControlFrameEncoding() throws {
        XCTAssertEqual(try frameType(LiveVoiceChannelClient.encodeControlFrame(type: "ptt_release")), "ptt_release")
        XCTAssertEqual(try frameType(LiveVoiceChannelClient.encodeControlFrame(type: "interrupt")), "interrupt")
        XCTAssertEqual(try frameType(LiveVoiceChannelClient.encodeControlFrame(type: "end")), "end")
    }

    // MARK: - Server Frame Decoding

    func testDecodeReadyFrame() {
        let result = LiveVoiceChannelClient.decodeServerFrame(#"{"type":"ready","sessionId":"session-1","conversationId":"conv-1"}"#)
        XCTAssertEqual(result, .event(.ready(sessionId: "session-1", conversationId: "conv-1")))
    }

    func testDecodeTranscriptAndAssistantFrames() {
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"stt_partial","text":"hel","seq":1}"#),
            .event(.sttPartial(text: "hel", seq: 1))
        )
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"stt_final","text":"hello","seq":2}"#),
            .event(.sttFinal(text: "hello", seq: 2))
        )
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"thinking","turnId":"turn-1"}"#),
            .event(.thinking(turnId: "turn-1"))
        )
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"assistant_text_delta","text":"Hi","seq":3}"#),
            .event(.assistantTextDelta(text: "Hi", seq: 3))
        )
    }

    func testTtsAudioFrameBase64DecodesIntoData() {
        let audio = Data([0, 1, 2, 3, 255])
        let json = """
        {"type":"tts_audio","mimeType":"audio/pcm","sampleRate":16000,"dataBase64":"\(audio.base64EncodedString())","seq":4}
        """

        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(json),
            .event(.ttsAudio(data: audio, mimeType: "audio/pcm", sampleRate: 16_000, seq: 4))
        )
    }

    func testMetricsAndArchivedFramesDecode() {
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"metrics","turnId":"turn-1","sttMs":50,"llmFirstDeltaMs":100,"ttsFirstAudioMs":150,"totalMs":250}"#),
            .event(.metrics(LiveVoiceChannelMetrics(
                turnId: "turn-1",
                sttMs: 50,
                llmFirstDeltaMs: 100,
                ttsFirstAudioMs: 150,
                totalMs: 250
            )))
        )
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"archived","conversationId":"conv-1","sessionId":"session-1"}"#),
            .event(.archived(conversationId: "conv-1", sessionId: "session-1"))
        )
    }

    func testBusyFrameMapsToTypedFailure() {
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"busy","activeSessionId":"session-active"}"#),
            .failure(.busy(activeSessionId: "session-active"))
        )
    }

    func testErrorFrameMapsToTypedFailure() {
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"error","code":"tts_failed","message":"TTS failed"}"#),
            .failure(.protocolError(code: "tts_failed", message: "TTS failed"))
        )
    }

    func testInvalidTtsAudioMapsToProtocolFailure() {
        XCTAssertEqual(
            LiveVoiceChannelClient.decodeServerFrame(#"{"type":"tts_audio","mimeType":"audio/pcm","sampleRate":16000,"dataBase64":"not base64","seq":4}"#),
            .failure(.protocolError(code: "invalid_tts_audio", message: "TTS audio frame missing or invalid audio data"))
        )
    }

    // MARK: - WebSocket Lifecycle

    func testStartSendsProviderAgnosticStartFrameAndBinaryAudioOnlyAfterReady() async throws {
        var capturedParams: [String: String]?
        let task = MockLiveVoiceWebSocketTask()
        let client = makeClient(task: task, capturedParams: &capturedParams)
        var events: [LiveVoiceChannelEvent] = []
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: "conv-123",
            audioFormat: .pcm16kMono,
            onEvent: { events.append($0) },
            onFailure: { failures.append($0) }
        )

        XCTAssertTrue(task.didResume)
        XCTAssertEqual(capturedParams, ["conversationId": "conv-123"])
        XCTAssertEqual(task.stringMessages.count, 1)
        XCTAssertEqual(try frameType(task.stringMessages[0]), "start")

        await client.sendAudio(Data([1, 2, 3]))
        XCTAssertTrue(task.dataMessages.isEmpty)

        client.parseServerFrame(#"{"type":"ready","sessionId":"session-1","conversationId":"conv-123"}"#)
        XCTAssertEqual(events, [.ready(sessionId: "session-1", conversationId: "conv-123")])

        let audio = Data([1, 2, 3])
        await client.sendAudio(audio)
        XCTAssertEqual(task.dataMessages, [audio])
        XCTAssertTrue(failures.isEmpty)

        await client.close()
    }

    func testControlFramesAndEndCancelReceiveLoopCleanly() async throws {
        let task = MockLiveVoiceWebSocketTask()
        let client = makeClient(task: task)
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: { failures.append($0) }
        )
        client.parseServerFrame(#"{"type":"ready","sessionId":"session-1","conversationId":"conv-1"}"#)

        await client.releasePushToTalk()
        await client.interrupt()
        await client.end()

        XCTAssertEqual(task.stringMessages.map { try? frameType($0) }, ["start", "ptt_release", "interrupt", "end"])
        XCTAssertEqual(task.cancelCodes, [.normalClosure])
        XCTAssertTrue(failures.isEmpty)
    }

    func testBusyFrameFailsAndClosesSession() async {
        let task = MockLiveVoiceWebSocketTask()
        let client = makeClient(task: task)
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: { failures.append($0) }
        )
        client.parseServerFrame(#"{"type":"busy","activeSessionId":"session-active"}"#)
        await client.sendAudio(Data([1, 2, 3]))

        XCTAssertEqual(failures, [.busy(activeSessionId: "session-active")])
        XCTAssertEqual(task.cancelCodes, [.normalClosure])
        XCTAssertTrue(task.dataMessages.isEmpty)
    }

    func testReceiveErrorWithHttpStatusMapsToConnectionRejected() async {
        let task = MockLiveVoiceWebSocketTask()
        task.response = HTTPURLResponse(
            url: URL(string: "wss://example.com/v1/live-voice")!,
            statusCode: 401,
            httpVersion: nil,
            headerFields: nil
        )
        task.receiveError = URLError(.badServerResponse)
        let client = makeClient(task: task)
        let exp = expectation(description: "failure reported")
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: {
                failures.append($0)
                exp.fulfill()
            }
        )

        await fulfillment(of: [exp], timeout: 1)
        XCTAssertEqual(failures, [.connectionRejected(statusCode: 401)])
    }

    func testReceiveErrorWithCloseCodeMapsToAbnormalClosure() async {
        let task = MockLiveVoiceWebSocketTask()
        task.closeCode = .internalServerError
        task.closeReason = Data("upstream failed".utf8)
        task.receiveError = URLError(.networkConnectionLost)
        let client = makeClient(task: task)
        let exp = expectation(description: "failure reported")
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: {
                failures.append($0)
                exp.fulfill()
            }
        )

        await fulfillment(of: [exp], timeout: 1)
        XCTAssertEqual(failures, [.abnormalClosure(code: URLSessionWebSocketTask.CloseCode.internalServerError.rawValue, reason: "upstream failed")])
    }

    func testReceiveErrorWithNormalCloseDoesNotFail() async throws {
        let task = MockLiveVoiceWebSocketTask()
        task.closeCode = .normalClosure
        task.receiveError = URLError(.networkConnectionLost)
        let client = makeClient(task: task)
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: { failures.append($0) }
        )

        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(failures.isEmpty)
        XCTAssertEqual(task.cancelCodes, [.normalClosure])
    }

    func testCloseIsIdempotent() async {
        let task = MockLiveVoiceWebSocketTask()
        let client = makeClient(task: task)
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: { failures.append($0) }
        )

        await client.close()
        await client.close()

        XCTAssertEqual(task.cancelCodes, [.normalClosure])
        XCTAssertTrue(failures.isEmpty)
    }

    // MARK: - Helpers

    private func makeClient(
        task: MockLiveVoiceWebSocketTask,
        capturedParams: UnsafeMutablePointer<[String: String]?>? = nil
    ) -> LiveVoiceChannelClient {
        LiveVoiceChannelClient(
            requestBuilder: { params in
                capturedParams?.pointee = params
                return URLRequest(url: URL(string: "wss://example.com/v1/live-voice")!)
            },
            webSocketFactory: { _ in task }
        )
    }

    private func decodeJSONObject(_ text: String) throws -> [String: Any] {
        let data = try XCTUnwrap(text.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func frameType(_ text: String) throws -> String {
        let json = try decodeJSONObject(text)
        return try XCTUnwrap(json["type"] as? String)
    }
}

private final class MockLiveVoiceWebSocketTask: LiveVoiceChannelWebSocketTask {
    var closeCode: URLSessionWebSocketTask.CloseCode = .invalid
    var closeReason: Data?
    var response: URLResponse?
    var receiveError: Error?

    private(set) var didResume = false
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    private(set) var cancelCodes: [URLSessionWebSocketTask.CloseCode] = []

    var stringMessages: [String] {
        sentMessages.compactMap { message in
            if case .string(let text) = message { return text }
            return nil
        }
    }

    var dataMessages: [Data] {
        sentMessages.compactMap { message in
            if case .data(let data) = message { return data }
            return nil
        }
    }

    func resume() {
        didResume = true
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        sentMessages.append(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        if let receiveError {
            throw receiveError
        }
        while !Task.isCancelled {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw URLError(.cancelled)
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancelCodes.append(closeCode)
        self.closeCode = closeCode
        self.closeReason = reason
    }
}
