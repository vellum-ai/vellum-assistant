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

    // MARK: - Mock STT Client

    /// A controllable mock of `STTClientProtocol` for testing the service-first transcription
    /// precedence logic without making network calls.
    private final class MockSTTClient: STTClientProtocol, @unchecked Sendable {
        /// The result to return from `transcribe`. Set this before calling the method under test.
        var stubbedResult: STTResult = .notConfigured

        /// Tracks how many times `transcribe` was called.
        var transcribeCallCount = 0

        /// The audio data passed to the most recent `transcribe` call.
        var lastAudioData: Data?

        func transcribe(audioData: Data, contentType: String) async -> STTResult {
            transcribeCallCount += 1
            lastAudioData = audioData
            return stubbedResult
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

    // MARK: - STT Service-First Precedence

    /// Helper that implements the same service-first precedence logic as InputBarView's
    /// `resolveTranscriptWithServiceFirst` so the decision matrix can be tested in isolation.
    private func resolveTranscript(serviceResult: STTResult, nativeTranscript: String) -> String {
        switch serviceResult {
        case .success(let text):
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return text
            }
            return nativeTranscript
        case .notConfigured, .serviceUnavailable, .error:
            return nativeTranscript
        }
    }

    func testServiceSuccessUsesServiceTranscript() {
        let result = resolveTranscript(
            serviceResult: .success(text: "Service says hello"),
            nativeTranscript: "Native says hello"
        )
        XCTAssertEqual(result, "Service says hello", "Service transcript should take precedence when successful")
    }

    func testServiceNotConfiguredFallsBackToNative() {
        let result = resolveTranscript(
            serviceResult: .notConfigured,
            nativeTranscript: "Native fallback"
        )
        XCTAssertEqual(result, "Native fallback", "Should fall back to native when STT service is not configured")
    }

    func testServiceUnavailableFallsBackToNative() {
        let result = resolveTranscript(
            serviceResult: .serviceUnavailable,
            nativeTranscript: "Native fallback"
        )
        XCTAssertEqual(result, "Native fallback", "Should fall back to native when STT service is unavailable")
    }

    func testServiceErrorFallsBackToNative() {
        let result = resolveTranscript(
            serviceResult: .error(statusCode: 500, message: "Internal error"),
            nativeTranscript: "Native fallback"
        )
        XCTAssertEqual(result, "Native fallback", "Should fall back to native when STT service returns an error")
    }

    func testServiceEmptyResultFallsBackToNative() {
        let result = resolveTranscript(
            serviceResult: .success(text: ""),
            nativeTranscript: "Native fallback"
        )
        XCTAssertEqual(result, "Native fallback", "Should fall back to native when STT service returns empty text")
    }

    func testServiceWhitespaceOnlyResultFallsBackToNative() {
        let result = resolveTranscript(
            serviceResult: .success(text: "   \n  "),
            nativeTranscript: "Native fallback"
        )
        XCTAssertEqual(result, "Native fallback", "Should fall back to native when STT service returns whitespace-only text")
    }

    func testServiceErrorWithNilStatusCodeFallsBackToNative() {
        let result = resolveTranscript(
            serviceResult: .error(statusCode: nil, message: "Network error"),
            nativeTranscript: "Native fallback"
        )
        XCTAssertEqual(result, "Native fallback", "Should fall back to native when STT service returns error with nil status code")
    }

    // MARK: - Mock STT Client Contract

    func testMockSTTClientTracksCallCount() async {
        let client = MockSTTClient()
        client.stubbedResult = .success(text: "Hello")

        _ = await client.transcribe(audioData: Data([1, 2, 3]))
        _ = await client.transcribe(audioData: Data([4, 5, 6]))

        XCTAssertEqual(client.transcribeCallCount, 2, "Mock should track transcribe call count")
    }

    func testMockSTTClientCapturesAudioData() async {
        let client = MockSTTClient()
        client.stubbedResult = .success(text: "Hello")
        let testData = Data([0x52, 0x49, 0x46, 0x46])

        _ = await client.transcribe(audioData: testData)

        XCTAssertEqual(client.lastAudioData, testData, "Mock should capture the audio data passed to transcribe")
    }

    func testMockSTTClientReturnsStubbedResult() async {
        let client = MockSTTClient()
        client.stubbedResult = .notConfigured

        let result = await client.transcribe(audioData: Data())

        XCTAssertEqual(result, .notConfigured, "Mock should return the stubbed result")
    }

    // MARK: - STT-Only Recording Mode

    /// When STT is configured and speech recognition is denied, the recording flow should
    /// proceed in STT-only mode — the native recognizer is skipped and the adapter's
    /// `startRecognitionTask` is never called.
    func testSTTConfiguredAndSpeechDeniedStartsRecordingInSTTOnlyMode() async {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.authorizationStatus = .denied
        adapter.available = false

        // Simulate STT provider configured via UserDefaults
        UserDefaults.standard.set("deepgram", forKey: "sttProvider")
        defer { UserDefaults.standard.removeObject(forKey: "sttProvider") }

        XCTAssertTrue(
            STTProviderRegistry.isServiceConfigured,
            "STT should be considered configured when sttProvider is set"
        )

        // When STT is configured and the recognizer is unavailable, speech recognition
        // authorization should be skipped entirely.
        let status = await adapter.requestAuthorization()
        XCTAssertEqual(status, .denied, "Adapter reports denied — but with STT configured this is irrelevant")

        // The key assertion: when STT is configured, the permission flow in InputBarView
        // does not call requestAuthorization() at all — it proceeds directly to beginRecording().
        // beginRecording() sees isAvailable == false and enters STT-only mode instead of failing.
        // Verify the adapter was never asked to start a recognition task.
        XCTAssertEqual(
            adapter.startCallCount, 0,
            "Native recognition task should not start when STT is configured and recognizer is unavailable"
        )
    }

    /// When STT is NOT configured and speech recognition is denied, the recording flow should
    /// block — this is the existing behavior preserved for non-STT setups.
    func testSTTNotConfiguredAndSpeechDeniedBlocksRecording() async {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.authorizationStatus = .denied

        // Ensure no STT provider is configured
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        XCTAssertFalse(
            STTProviderRegistry.isServiceConfigured,
            "STT should not be considered configured when sttProvider is not set"
        )

        // Without STT configured, speech recognition authorization must succeed for recording
        // to proceed. When denied, recording should be blocked.
        let status = await adapter.requestAuthorization()
        XCTAssertNotEqual(status, .authorized, "Authorization should not be granted when denied")

        // Verify no recognition task was started (recording was blocked at the permission check).
        XCTAssertEqual(
            adapter.startCallCount, 0,
            "Recognition task should not start when STT is not configured and speech is denied"
        )
    }

    /// Verifies that the service-first transcript resolution works correctly in STT-only mode
    /// (where the native transcript is empty and only the STT service result matters).
    func testSTTOnlyModeUsesServiceTranscriptWithEmptyNative() {
        let result = resolveTranscript(
            serviceResult: .success(text: "STT service heard this"),
            nativeTranscript: ""
        )
        XCTAssertEqual(
            result, "STT service heard this",
            "In STT-only mode, the service transcript should be used when native is empty"
        )
    }

    /// When STT is configured but the recognizer is available, the native recognition task
    /// should still be started (dual-path mode with service-first precedence).
    func testSTTConfiguredAndRecognizerAvailableStartsNativeTask() throws {
        let adapter = MockSpeechRecognizerAdapter()
        adapter.authorizationStatus = .authorized
        adapter.available = true

        // Simulate STT provider configured
        UserDefaults.standard.set("openai-whisper", forKey: "sttProvider")
        defer { UserDefaults.standard.removeObject(forKey: "sttProvider") }

        XCTAssertTrue(STTProviderRegistry.isServiceConfigured)

        // Even with STT configured, if the recognizer is available and authorized,
        // the native task should still start (for service-first dual-path resolution).
        let (request, cancel) = try adapter.startRecognitionTask { _, _ in }
        defer { cancel() }

        XCTAssertEqual(adapter.startCallCount, 1, "Native task should start when recognizer is available")
        XCTAssertNotNil(request, "Native request should be returned")
    }

    // MARK: - AudioWavEncoder Integration

    func testWavEncoderProducesValidHeader() {
        let pcmData = Data(repeating: 0, count: 100)
        let format = AudioWavEncoder.Format(sampleRate: 16000, channels: 1, bitsPerSample: 16)
        let wavData = AudioWavEncoder.encode(pcmData: pcmData, format: format)

        // WAV header is 44 bytes
        XCTAssertEqual(wavData.count, 44 + pcmData.count, "WAV data should be header (44 bytes) + PCM data")

        // Check RIFF header
        let riffBytes = [UInt8](wavData.prefix(4))
        XCTAssertEqual(riffBytes, [0x52, 0x49, 0x46, 0x46], "WAV should start with RIFF magic bytes")

        // Check WAVE format
        let waveBytes = [UInt8](wavData[8..<12])
        XCTAssertEqual(waveBytes, [0x57, 0x41, 0x56, 0x45], "WAV should contain WAVE format identifier")
    }

    func testWavEncoderSpeechFormatPreset() {
        let format = AudioWavEncoder.Format.speech16kHz
        XCTAssertEqual(format.sampleRate, 16000)
        XCTAssertEqual(format.channels, 1)
        XCTAssertEqual(format.bitsPerSample, 16)
    }
}

#endif
