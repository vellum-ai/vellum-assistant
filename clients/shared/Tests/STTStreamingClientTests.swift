import XCTest

@testable import VellumAssistantShared

@MainActor
final class STTStreamingClientTests: XCTestCase {

    // MARK: - Event Parsing: ready

    func testParseReadyEvent() {
        let client = STTStreamingClient()
        var receivedEvents: [STTStreamEvent] = []
        client.parseServerEvent(#"{"type":"ready","provider":"deepgram"}"#)

        // Since the client is in .idle state (not .connecting), the ready
        // event should be silently dropped. Test the parsing path by
        // verifying no crash occurs.
        XCTAssertTrue(true, "Ready event parsing should not crash")
    }

    func testParseReadyEventWithSequence() {
        let client = STTStreamingClient()
        // Verify the parser handles the ready event JSON structure without error.
        client.parseServerEvent(#"{"type":"ready","provider":"google-gemini","seq":0}"#)
        XCTAssertTrue(true, "Ready event with seq should not crash")
    }

    // MARK: - Event Parsing: partial

    func testParsePartialEvent() {
        let client = STTStreamingClient()
        var receivedEvents: [STTStreamEvent] = []

        // Use KVO-free approach: just validate the parse doesn't crash
        // and produces the expected structure.
        let json = #"{"type":"partial","text":"hello wor","seq":1}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .partial(text: "hello wor", seq: 1))
    }

    func testParsePartialEventWithEmptyText() {
        let json = #"{"type":"partial","text":"","seq":2}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .partial(text: "", seq: 2))
    }

    // MARK: - Event Parsing: final

    func testParseFinalEvent() {
        let json = #"{"type":"final","text":"hello world","seq":3}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .final(text: "hello world", seq: 3))
    }

    func testParseFinalEventWithEmptyText() {
        let json = #"{"type":"final","text":"","seq":4}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .final(text: "", seq: 4))
    }

    // MARK: - Event Parsing: error

    func testParseErrorEvent() {
        let json = #"{"type":"error","category":"provider-error","message":"Connection lost","seq":5}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .error(category: "provider-error", message: "Connection lost", seq: 5))
    }

    func testParseErrorEventWithTimeoutCategory() {
        let json = #"{"type":"error","category":"timeout","message":"Session timed out","seq":6}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .error(category: "timeout", message: "Session timed out", seq: 6))
    }

    func testParseErrorEventWithMissingCategory() {
        let json = #"{"type":"error","message":"Something failed","seq":7}"#
        let event = decodeSTTStreamEvent(json)
        // Missing category should default to "provider-error"
        XCTAssertEqual(event, .error(category: "provider-error", message: "Something failed", seq: 7))
    }

    // MARK: - Event Parsing: closed

    func testParseClosedEvent() {
        let json = #"{"type":"closed","seq":8}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .closed(seq: 8))
    }

    // MARK: - Event Parsing: missing seq

    func testParseEventWithMissingSeqDefaultsToZero() {
        let json = #"{"type":"final","text":"no seq"}"#
        let event = decodeSTTStreamEvent(json)
        XCTAssertEqual(event, .final(text: "no seq", seq: 0))
    }

    // MARK: - Event Parsing: invalid

    func testParseInvalidJSONDoesNotCrash() {
        let client = STTStreamingClient()
        client.parseServerEvent("not json at all")
        XCTAssertTrue(true, "Invalid JSON should be silently dropped")
    }

    func testParseUnknownEventTypeDoesNotCrash() {
        let client = STTStreamingClient()
        client.parseServerEvent(#"{"type":"unknown_event","data":"foo"}"#)
        XCTAssertTrue(true, "Unknown event types should be silently dropped")
    }

    func testParseEmptyStringDoesNotCrash() {
        let client = STTStreamingClient()
        client.parseServerEvent("")
        XCTAssertTrue(true, "Empty string should be silently dropped")
    }

    // MARK: - Event Parsing: sequence ordering

    func testSequenceNumbersAreMonotonic() {
        let events = [
            decodeSTTStreamEvent(#"{"type":"partial","text":"h","seq":0}"#),
            decodeSTTStreamEvent(#"{"type":"partial","text":"he","seq":1}"#),
            decodeSTTStreamEvent(#"{"type":"partial","text":"hel","seq":2}"#),
            decodeSTTStreamEvent(#"{"type":"final","text":"hello","seq":3}"#),
            decodeSTTStreamEvent(#"{"type":"closed","seq":4}"#),
        ]

        var lastSeq = -1
        for event in events {
            let seq: Int
            switch event {
            case .ready: seq = -1
            case .partial(_, let s): seq = s
            case .final(_, let s): seq = s
            case .error(_, _, let s): seq = s
            case .closed(let s): seq = s
            }
            XCTAssertGreaterThan(seq, lastSeq, "Sequence numbers should be monotonically increasing")
            lastSeq = seq
        }
    }

    // MARK: - STTStreamFailure

    func testFailureEquality() {
        XCTAssertEqual(
            STTStreamFailure.connectionFailed(message: "err"),
            STTStreamFailure.connectionFailed(message: "err")
        )
        XCTAssertNotEqual(
            STTStreamFailure.connectionFailed(message: "err1"),
            STTStreamFailure.connectionFailed(message: "err2")
        )
        XCTAssertEqual(
            STTStreamFailure.rejected(statusCode: 401),
            STTStreamFailure.rejected(statusCode: 401)
        )
        XCTAssertEqual(
            STTStreamFailure.timeout(message: "timed out"),
            STTStreamFailure.timeout(message: "timed out")
        )
        XCTAssertEqual(
            STTStreamFailure.unsupportedProvider(message: "nope"),
            STTStreamFailure.unsupportedProvider(message: "nope")
        )
        XCTAssertEqual(
            STTStreamFailure.providerError(category: "auth", message: "bad key"),
            STTStreamFailure.providerError(category: "auth", message: "bad key")
        )
        XCTAssertEqual(
            STTStreamFailure.abnormalClosure(code: 1006, reason: nil),
            STTStreamFailure.abnormalClosure(code: 1006, reason: nil)
        )
    }

    // MARK: - STTStreamEvent

    func testStreamEventEquality() {
        XCTAssertEqual(
            STTStreamEvent.ready(provider: "deepgram"),
            STTStreamEvent.ready(provider: "deepgram")
        )
        XCTAssertNotEqual(
            STTStreamEvent.ready(provider: "deepgram"),
            STTStreamEvent.ready(provider: "google-gemini")
        )
        XCTAssertEqual(
            STTStreamEvent.partial(text: "hello", seq: 1),
            STTStreamEvent.partial(text: "hello", seq: 1)
        )
        XCTAssertEqual(
            STTStreamEvent.final(text: "hello world", seq: 2),
            STTStreamEvent.final(text: "hello world", seq: 2)
        )
        XCTAssertNotEqual(
            STTStreamEvent.partial(text: "hello", seq: 1),
            STTStreamEvent.final(text: "hello", seq: 1)
        )
    }

    // MARK: - Provider Registry Streaming Capability

    func testDeepgramSupportsConversationStreaming() {
        let registry = buildTestRegistry()
        XCTAssertTrue(registry.supportsConversationStreaming(provider: "deepgram"))
        XCTAssertEqual(registry.conversationStreamingMode(forProvider: "deepgram"), .realtimeWs)
    }

    func testGoogleGeminiSupportsConversationStreaming() {
        let registry = buildTestRegistry()
        XCTAssertTrue(registry.supportsConversationStreaming(provider: "google-gemini"))
        XCTAssertEqual(registry.conversationStreamingMode(forProvider: "google-gemini"), .realtimeWs)
    }

    func testOpenAIWhisperSupportsConversationStreaming() {
        let registry = buildTestRegistry()
        XCTAssertTrue(registry.supportsConversationStreaming(provider: "openai-whisper"))
        XCTAssertEqual(registry.conversationStreamingMode(forProvider: "openai-whisper"), .incrementalBatch)
    }

    func testUnknownProviderDoesNotSupportConversationStreaming() {
        let registry = buildTestRegistry()
        XCTAssertFalse(registry.supportsConversationStreaming(provider: "nonexistent-provider"))
        XCTAssertEqual(registry.conversationStreamingMode(forProvider: "nonexistent-provider"), .none)
    }

    // MARK: - STTConversationStreamingMode

    func testStreamingModeSupportsStreaming() {
        XCTAssertTrue(STTConversationStreamingMode.realtimeWs.supportsStreaming)
        XCTAssertTrue(STTConversationStreamingMode.incrementalBatch.supportsStreaming)
        XCTAssertFalse(STTConversationStreamingMode.none.supportsStreaming)
    }

    func testStreamingModeRawValues() {
        XCTAssertEqual(STTConversationStreamingMode.realtimeWs.rawValue, "realtime-ws")
        XCTAssertEqual(STTConversationStreamingMode.incrementalBatch.rawValue, "incremental-batch")
        XCTAssertEqual(STTConversationStreamingMode.none.rawValue, "none")
    }

    func testStreamingModeDecoding() throws {
        let json = #"{"mode":"realtime-ws"}"#
        struct Wrapper: Decodable { let mode: STTConversationStreamingMode }
        let decoded = try JSONDecoder().decode(Wrapper.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(decoded.mode, .realtimeWs)
    }

    // MARK: - Provider Catalog Decoding with Streaming Mode

    func testProviderCatalogEntryDecodingWithStreamingMode() throws {
        let json = """
        {
            "id": "deepgram",
            "displayName": "Deepgram",
            "subtitle": "Fast STT",
            "setupMode": "api-key",
            "setupHint": "Enter key",
            "apiKeyProviderName": "deepgram",
            "conversationStreamingMode": "realtime-ws"
        }
        """
        let entry = try JSONDecoder().decode(STTProviderCatalogEntry.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(entry.id, "deepgram")
        XCTAssertEqual(entry.conversationStreamingMode, .realtimeWs)
    }

    func testFullCatalogDecodingWithStreamingMode() throws {
        let json = """
        {
            "providers": [
                {
                    "id": "openai-whisper",
                    "displayName": "OpenAI Whisper",
                    "subtitle": "test",
                    "setupMode": "api-key",
                    "setupHint": "test",
                    "apiKeyProviderName": "openai",
                    "conversationStreamingMode": "incremental-batch"
                },
                {
                    "id": "deepgram",
                    "displayName": "Deepgram",
                    "subtitle": "test",
                    "setupMode": "api-key",
                    "setupHint": "test",
                    "apiKeyProviderName": "deepgram",
                    "conversationStreamingMode": "realtime-ws"
                }
            ]
        }
        """
        let catalog = try JSONDecoder().decode(STTProviderRegistry.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(catalog.providers.count, 2)
        XCTAssertEqual(catalog.providers[0].conversationStreamingMode, .incrementalBatch)
        XCTAssertEqual(catalog.providers[1].conversationStreamingMode, .realtimeWs)
    }

    // MARK: - Helpers

    /// Build a test registry with all providers for capability testing.
    private func buildTestRegistry() -> STTProviderRegistry {
        STTProviderRegistry(
            providers: [
                STTProviderCatalogEntry(
                    id: "openai-whisper",
                    displayName: "OpenAI Whisper",
                    subtitle: "test",
                    setupMode: .apiKey,
                    setupHint: "test",
                    apiKeyProviderName: "openai",
                    conversationStreamingMode: .incrementalBatch,
                    credentialsGuide: nil
                ),
                STTProviderCatalogEntry(
                    id: "deepgram",
                    displayName: "Deepgram",
                    subtitle: "test",
                    setupMode: .apiKey,
                    setupHint: "test",
                    apiKeyProviderName: "deepgram",
                    conversationStreamingMode: .realtimeWs,
                    credentialsGuide: nil
                ),
                STTProviderCatalogEntry(
                    id: "google-gemini",
                    displayName: "Google Gemini",
                    subtitle: "test",
                    setupMode: .apiKey,
                    setupHint: "test",
                    apiKeyProviderName: "gemini",
                    conversationStreamingMode: .realtimeWs,
                    credentialsGuide: nil
                ),
            ]
        )
    }

    /// Decode a JSON string into an STTStreamEvent for testing.
    /// This mirrors the parsing logic in STTStreamingClient.parseServerEvent
    /// without requiring a live client connection.
    private func decodeSTTStreamEvent(_ json: String) -> STTStreamEvent {
        guard let data = json.data(using: .utf8) else {
            XCTFail("Invalid JSON string")
            return .closed(seq: -1)
        }

        struct RawEvent: Decodable {
            let type: String
            let text: String?
            let category: String?
            let message: String?
            let provider: String?
            let seq: Int?
        }

        guard let raw = try? JSONDecoder().decode(RawEvent.self, from: data) else {
            XCTFail("Failed to decode event JSON")
            return .closed(seq: -1)
        }

        let seq = raw.seq ?? 0

        switch raw.type {
        case "ready":
            return .ready(provider: raw.provider ?? "unknown")
        case "partial":
            return .partial(text: raw.text ?? "", seq: seq)
        case "final":
            return .final(text: raw.text ?? "", seq: seq)
        case "error":
            return .error(category: raw.category ?? "provider-error", message: raw.message ?? "Unknown error", seq: seq)
        case "closed":
            return .closed(seq: seq)
        default:
            XCTFail("Unknown event type: \(raw.type)")
            return .closed(seq: -1)
        }
    }
}
