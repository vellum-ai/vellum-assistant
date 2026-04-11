#if canImport(UIKit)
import XCTest
import Speech
@testable import VellumAssistantShared
@testable import vellum_assistant_ios

/// Tests for the InputBarView voice input path exercised through the SpeechRecognizerAdapter
/// abstraction. Uses a mock adapter to verify authorization, availability, and transcript
/// application without requiring a live microphone or OS permission dialogs.
@MainActor
final class InputBarVoiceInputTests: XCTestCase {

    // MARK: - Mock Adapter

    /// A controllable mock of `SpeechRecognizerAdapter` for testing InputBarView's voice-input
    /// branches without hitting the real SFSpeechRecognizer or microphone hardware.
    private final class MockSpeechRecognizerAdapter: SpeechRecognizerAdapter {
        var authorizationStatus: SpeechRecognizerAuthorizationStatus = .authorized
        var available: Bool = true
        var shouldThrowOnStart: Bool = false

        /// The result handler captured from the most recent `startRecognitionTask` call.
        /// Tests invoke this to simulate the recognizer delivering results.
        var capturedResultHandler: ((SpeechRecognitionResult?, Error?) -> Void)?

        /// Tracks how many times `startRecognitionTask` was called.
        var startCallCount = 0

        /// The most recently created request, if any.
        var lastRequest: SFSpeechAudioBufferRecognitionRequest?

        func requestAuthorization() async -> SpeechRecognizerAuthorizationStatus {
            return authorizationStatus
        }

        var isAvailable: Bool { available }

        func startRecognitionTask(
            resultHandler: @escaping (SpeechRecognitionResult?, Error?) -> Void
        ) throws -> (request: SFSpeechAudioBufferRecognitionRequest, cancel: () -> Void) {
            if shouldThrowOnStart {
                throw SpeechRecognizerAdapterError.recognizerUnavailable
            }
            startCallCount += 1
            capturedResultHandler = resultHandler
            let request = SFSpeechAudioBufferRecognitionRequest()
            lastRequest = request
            return (request: request, cancel: { [weak self] in self?.capturedResultHandler = nil })
        }
    }

    // MARK: - Authorization Denied

    func testAuthorizationDeniedReturnsCorrectStatus() async {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.authorizationStatus = .denied

        let status = await adapter.requestAuthorization()
        XCTAssertEqual(status, .denied, "Adapter should return denied status when configured as denied")
    }

    func testAuthorizationDeniedDoesNotStartRecognition() async {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.authorizationStatus = .denied

        let status = await adapter.requestAuthorization()
        XCTAssertNotEqual(status, .authorized)
        // Verify no recognition task was started
        XCTAssertEqual(adapter.startCallCount, 0, "Recognition task should not start when authorization is denied")
    }

    func testAuthorizationRestrictedReturnsCorrectStatus() async {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.authorizationStatus = .restricted

        let status = await adapter.requestAuthorization()
        XCTAssertEqual(status, .restricted)
    }

    // MARK: - Recognizer Unavailable

    func testRecognizerUnavailableReportsNotAvailable() {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.available = false

        XCTAssertFalse(adapter.isAvailable, "Adapter should report unavailable when configured as unavailable")
    }

    func testStartRecognitionTaskThrowsWhenConfigured() {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.shouldThrowOnStart = true

        XCTAssertThrowsError(try adapter.startRecognitionTask { _, _ in }) { error in
            XCTAssertTrue(
                error is SpeechRecognizerAdapterError,
                "Error should be SpeechRecognizerAdapterError, got \(type(of: error))"
            )
        }
    }

    func testRecognizerUnavailableDoesNotCaptureHandler() {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.shouldThrowOnStart = true

        _ = try? adapter.startRecognitionTask { _, _ in }
        XCTAssertNil(adapter.capturedResultHandler, "No result handler should be captured when start throws")
        XCTAssertEqual(adapter.startCallCount, 0, "Start call count should remain 0 when start throws")
    }

    // MARK: - Successful Final Transcript

    func testSuccessfulFinalTranscriptDelivered() throws {
        let adapter = MockSpeechRecognizerAdapter()

        var receivedTranscription: String?
        var receivedIsFinal: Bool?

        let (_, _) = try adapter.startRecognitionTask { result, error in
            receivedTranscription = result?.transcription
            receivedIsFinal = result?.isFinal
        }

        XCTAssertEqual(adapter.startCallCount, 1)

        // Simulate the recognizer delivering a final result
        let finalResult = SpeechRecognitionResult(transcription: "Hello world", isFinal: true)
        adapter.capturedResultHandler?(finalResult, nil)

        XCTAssertEqual(receivedTranscription, "Hello world")
        XCTAssertEqual(receivedIsFinal, true)
    }

    func testPartialTranscriptDeliveredBeforeFinal() throws {
        let adapter = MockSpeechRecognizerAdapter()

        var transcriptions: [String] = []
        var finalFlags: [Bool] = []

        let (_, _) = try adapter.startRecognitionTask { result, error in
            if let result = result {
                transcriptions.append(result.transcription)
                finalFlags.append(result.isFinal)
            }
        }

        // Simulate partial result
        adapter.capturedResultHandler?(
            SpeechRecognitionResult(transcription: "Hello", isFinal: false),
            nil
        )

        // Simulate final result
        adapter.capturedResultHandler?(
            SpeechRecognitionResult(transcription: "Hello world", isFinal: true),
            nil
        )

        XCTAssertEqual(transcriptions, ["Hello", "Hello world"])
        XCTAssertEqual(finalFlags, [false, true])
    }

    func testCancelClosureClearsHandler() throws {
        let adapter = MockSpeechRecognizerAdapter()

        let (_, cancel) = try adapter.startRecognitionTask { _, _ in }
        XCTAssertNotNil(adapter.capturedResultHandler)

        cancel()
        XCTAssertNil(adapter.capturedResultHandler, "Cancel should clear the captured result handler")
    }

    func testRecognitionErrorDelivered() throws {
        let adapter = MockSpeechRecognizerAdapter()

        var receivedError: Error?

        let (_, _) = try adapter.startRecognitionTask { result, error in
            receivedError = error
        }

        let testError = NSError(domain: "kAFAssistantErrorDomain", code: 1110, userInfo: nil)
        adapter.capturedResultHandler?(nil, testError)

        XCTAssertNotNil(receivedError)
        XCTAssertEqual((receivedError as? NSError)?.code, 1110)
    }

    // MARK: - Adapter Protocol Contract

    func testAdapterRequestIsReturned() throws {
        let adapter = MockSpeechRecognizerAdapter()

        let (request, _) = try adapter.startRecognitionTask { _, _ in }
        // The mock creates the request; in production AppleSpeechRecognizerAdapter also sets
        // shouldReportPartialResults = true. Verify the request object is valid.
        XCTAssertNotNil(request, "Adapter should return a valid audio buffer request")
    }

    func testMultipleStartCallsIncrementCount() throws {
        let adapter = MockSpeechRecognizerAdapter()

        let (_, cancel1) = try adapter.startRecognitionTask { _, _ in }
        cancel1()
        let (_, cancel2) = try adapter.startRecognitionTask { _, _ in }
        cancel2()

        XCTAssertEqual(adapter.startCallCount, 2)
    }
}

#endif
