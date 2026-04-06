import Foundation

/// Protocol abstracting voice service capabilities for testability.
/// `OpenAIVoiceService` is the production implementation; tests use `MockVoiceService`.
@MainActor
protocol VoiceServiceProtocol: AnyObject {
    var onSilenceDetected: (() -> Void)? { get set }
    var onMicrophoneAuthorized: (() -> Void)? { get set }
    var onBargeInDetected: (() -> Void)? { get set }
    var livePartialText: String { get }
    func hasElevenLabsKey() async -> Bool

    func prewarmEngine()
    @discardableResult func startRecording() -> Bool
    func stopRecordingAndGetTranscription() async -> String?
    func cancelRecording()
    func shutdown()
    func feedTextDelta(_ delta: String)
    func finishTextStream(onComplete: @escaping () -> Void)
    func resetStreamingTTS()
    func stopSpeaking()
    func startBargeInMonitor()
    func stopBargeInMonitor()
}
