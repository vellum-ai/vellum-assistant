import XCTest
@testable import VellumAssistantShared

/// Parity tests for `TTSClient.parseEnvelopeMessage` — mirrors the daemon's
/// standard JSON error envelope `{"error":{"code":"...","message":"..."}}`.
///
/// Keeps the client in sync with the route serializer in
/// `assistant/src/runtime/http-errors.ts`.
final class TTSClientEnvelopeTests: XCTestCase {

    func testExtractsMessageFromStandardEnvelope() {
        let body = #"""
        {"error":{"code":"BAD_GATEWAY","message":"TTS synthesis failed (provider: elevenlabs): Free users cannot use library voices via the API."}}
        """#
        let data = Data(body.utf8)
        XCTAssertEqual(
            TTSClient.parseEnvelopeMessage(data),
            "TTS synthesis failed (provider: elevenlabs): Free users cannot use library voices via the API."
        )
    }

    func testReturnsNilForEmptyData() {
        XCTAssertNil(TTSClient.parseEnvelopeMessage(Data()))
    }

    func testReturnsNilForNonJsonBody() {
        let data = Data("not json".utf8)
        XCTAssertNil(TTSClient.parseEnvelopeMessage(data))
    }

    func testReturnsNilWhenErrorObjectMissing() {
        let body = #"{"unrelated":{"message":"nope"}}"#
        let data = Data(body.utf8)
        XCTAssertNil(TTSClient.parseEnvelopeMessage(data))
    }

    func testReturnsNilWhenMessageFieldMissing() {
        let body = #"{"error":{"code":"BAD_GATEWAY"}}"#
        let data = Data(body.utf8)
        XCTAssertNil(TTSClient.parseEnvelopeMessage(data))
    }

    func testReturnsNilForBlankMessage() {
        let body = #"{"error":{"code":"BAD_GATEWAY","message":"   \n  "}}"#
        let data = Data(body.utf8)
        XCTAssertNil(TTSClient.parseEnvelopeMessage(data))
    }

    func testTrimsSurroundingWhitespace() {
        let body = #"{"error":{"code":"BAD_GATEWAY","message":"  Quota exceeded  "}}"#
        let data = Data(body.utf8)
        XCTAssertEqual(TTSClient.parseEnvelopeMessage(data), "Quota exceeded")
    }
}
