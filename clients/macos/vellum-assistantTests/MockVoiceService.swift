import Foundation
@testable import VellumAssistantLib

@MainActor
final class MockVoiceService: VoiceServiceProtocol {
    var onSilenceDetected: (() -> Void)?
    var onMicrophoneAuthorized: (() -> Void)?
    var onBargeInDetected: (() -> Void)?
    var livePartialText: String = ""
    var _hasElevenLabsKey: Bool = false
    func hasElevenLabsKey() async -> Bool { _hasElevenLabsKey }

    // MARK: - Spy Flags

    var prewarmEngineCalled = false
    var startRecordingCalled = false
    var stopRecordingCalled = false
    var cancelRecordingCalled = false
    var shutdownCalled = false
    var feedTextDeltaCalled = false
    var finishTextStreamCalled = false
    var resetStreamingTTSCalled = false
    var stopSpeakingCalled = false
    var startBargeInMonitorCalled = false
    var stopBargeInMonitorCalled = false

    var fedTextDeltas: [String] = []

    // MARK: - Configurable Return Values

    var startRecordingResult: Bool = true
    var transcriptionToReturn: String? = "test transcription"

    // MARK: - Stored Completions

    /// Stored completion from `finishTextStream` — call this in tests to simulate TTS completing.
    var finishTextStreamCompletion: (() -> Void)?

    // MARK: - Protocol Methods

    func prewarmEngine() {
        prewarmEngineCalled = true
    }

    @discardableResult
    func startRecording() -> Bool {
        startRecordingCalled = true
        return startRecordingResult
    }

    func stopRecordingAndGetTranscription() async -> String? {
        stopRecordingCalled = true
        return transcriptionToReturn
    }

    func cancelRecording() {
        cancelRecordingCalled = true
    }

    func shutdown() {
        shutdownCalled = true
    }

    func feedTextDelta(_ delta: String) {
        feedTextDeltaCalled = true
        fedTextDeltas.append(delta)
    }

    func finishTextStream(onComplete: @escaping () -> Void) {
        finishTextStreamCalled = true
        finishTextStreamCompletion = onComplete
    }

    func resetStreamingTTS() {
        resetStreamingTTSCalled = true
    }

    func stopSpeaking() {
        stopSpeakingCalled = true
    }

    func startBargeInMonitor() {
        startBargeInMonitorCalled = true
    }

    func stopBargeInMonitor() {
        stopBargeInMonitorCalled = true
    }

    // MARK: - Test Helpers

    func reset() {
        prewarmEngineCalled = false
        startRecordingCalled = false
        stopRecordingCalled = false
        cancelRecordingCalled = false
        shutdownCalled = false
        feedTextDeltaCalled = false
        finishTextStreamCalled = false
        resetStreamingTTSCalled = false
        stopSpeakingCalled = false
        startBargeInMonitorCalled = false
        stopBargeInMonitorCalled = false
        fedTextDeltas = []
        finishTextStreamCompletion = nil
    }
}
