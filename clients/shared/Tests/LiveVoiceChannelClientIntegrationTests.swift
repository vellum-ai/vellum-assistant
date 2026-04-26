import Foundation
import XCTest

@testable import VellumAssistantShared

@MainActor
final class LiveVoiceChannelClientIntegrationTests: XCTestCase {

    func testScriptedSessionSendsTextAndBinaryFramesAndDecodesServerEvents() async throws {
        var capturedParams: [String: String]?
        let task = ScriptedLiveVoiceWebSocketTask()
        let client = makeClient(task: task, capturedParams: &capturedParams)
        var events: [LiveVoiceChannelEvent] = []
        var failures: [LiveVoiceChannelFailure] = []
        let audio = Data([0, 1, 2, 255])

        await client.start(
            conversationId: "conv-123",
            audioFormat: .pcm16kMono,
            onEvent: { events.append($0) },
            onFailure: { failures.append($0) }
        )
        task.enqueueString(#"{"type":"ready","sessionId":"session-123","conversationId":"conv-123","seq":1}"#)
        try await waitUntil { events == [.ready(sessionId: "session-123", conversationId: "conv-123")] }

        await client.sendAudio(audio)
        await client.releasePushToTalk()
        task.enqueueString(#"{"type":"stt_final","text":"hello","seq":2}"#)
        task.enqueueString(#"{"type":"thinking","turnId":"turn-123","seq":3}"#)
        task.enqueueString(#"{"type":"assistant_text_delta","text":"Hi there.","seq":4}"#)
        task.enqueueString("""
        {"type":"tts_audio","mimeType":"audio/pcm","sampleRate":16000,"dataBase64":"\(audio.base64EncodedString())","seq":5}
        """)
        task.enqueueString(#"{"type":"tts_done","turnId":"turn-123","seq":6}"#)
        task.enqueueString(#"{"type":"metrics","turnId":"turn-123","sttMs":25,"llmFirstDeltaMs":50,"ttsFirstAudioMs":75,"totalMs":100,"seq":7}"#)
        task.enqueueString(#"{"type":"archived","conversationId":"conv-123","sessionId":"session-123","seq":8}"#)
        try await waitUntil { events.count == 8 }

        await client.end()

        XCTAssertEqual(capturedParams, ["conversationId": "conv-123"])
        XCTAssertTrue(task.didResume)
        XCTAssertEqual(task.stringMessages.map { try? frameType($0) }, ["start", "ptt_release", "end"])
        XCTAssertEqual(task.dataMessages, [audio])
        XCTAssertEqual(events, [
            .ready(sessionId: "session-123", conversationId: "conv-123"),
            .sttFinal(text: "hello", seq: 2),
            .thinking(turnId: "turn-123"),
            .assistantTextDelta(text: "Hi there.", seq: 4),
            .ttsAudio(data: audio, mimeType: "audio/pcm", sampleRate: 16_000, seq: 5),
            .ttsDone(turnId: "turn-123"),
            .metrics(LiveVoiceChannelMetrics(
                turnId: "turn-123",
                sttMs: 25,
                llmFirstDeltaMs: 50,
                ttsFirstAudioMs: 75,
                totalMs: 100
            )),
            .archived(conversationId: "conv-123", sessionId: "session-123"),
        ])
        XCTAssertEqual(task.cancelCodes, [.normalClosure])
        XCTAssertTrue(failures.isEmpty)
    }

    func testBusyFrameReportsTypedFailureAndClosesWithoutSendingAudio() async throws {
        let task = ScriptedLiveVoiceWebSocketTask()
        let client = makeClient(task: task)
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: { failures.append($0) }
        )
        task.enqueueString(#"{"type":"busy","activeSessionId":"session-active","seq":1}"#)
        try await waitUntil { failures == [.busy(activeSessionId: "session-active")] }

        await client.sendAudio(Data([1, 2, 3]))

        XCTAssertEqual(task.stringMessages.map { try? frameType($0) }, ["start"])
        XCTAssertTrue(task.dataMessages.isEmpty)
        XCTAssertEqual(task.cancelCodes, [.normalClosure])
    }

    func testAbnormalCloseMapsToTypedFailure() async throws {
        let task = ScriptedLiveVoiceWebSocketTask()
        task.closeCode = .internalServerError
        task.closeReason = Data("upstream failed".utf8)
        let client = makeClient(task: task)
        var failures: [LiveVoiceChannelFailure] = []

        await client.start(
            conversationId: nil,
            audioFormat: .pcm16kMono,
            onEvent: { _ in },
            onFailure: { failures.append($0) }
        )
        task.failNextReceive(URLError(.networkConnectionLost))

        try await waitUntil {
            failures == [
                .abnormalClosure(
                    code: URLSessionWebSocketTask.CloseCode.internalServerError.rawValue,
                    reason: "upstream failed"
                ),
            ]
        }
        XCTAssertEqual(task.cancelCodes, [.normalClosure])
    }

    private func makeClient(
        task: ScriptedLiveVoiceWebSocketTask,
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

    private func waitUntil(
        timeout: TimeInterval = 1.0,
        _ predicate: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Timed out waiting for live voice client integration condition")
    }

    private func frameType(_ text: String) throws -> String {
        let data = try XCTUnwrap(text.data(using: .utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(json["type"] as? String)
    }
}

private final class ScriptedLiveVoiceWebSocketTask: LiveVoiceChannelWebSocketTask {
    var closeCode: URLSessionWebSocketTask.CloseCode = .invalid
    var closeReason: Data?
    var response: URLResponse?

    private(set) var didResume = false
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    private(set) var cancelCodes: [URLSessionWebSocketTask.CloseCode] = []
    private var queuedMessages: [URLSessionWebSocketTask.Message] = []
    private var receiveError: Error?

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

    func enqueueString(_ text: String) {
        queuedMessages.append(.string(text))
    }

    func failNextReceive(_ error: Error) {
        receiveError = error
    }

    func resume() {
        didResume = true
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        sentMessages.append(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        while !Task.isCancelled {
            if let receiveError {
                self.receiveError = nil
                throw receiveError
            }
            if !queuedMessages.isEmpty {
                return queuedMessages.removeFirst()
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        throw URLError(.cancelled)
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancelCodes.append(closeCode)
        self.closeCode = closeCode
        closeReason = reason
    }
}
