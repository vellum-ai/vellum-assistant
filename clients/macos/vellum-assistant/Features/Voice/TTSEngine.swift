import Foundation
import AVFoundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "TTSEngine")

@MainActor
final class TTSEngine: NSObject, ObservableObject {
    @Published var isSpeaking = false
    @Published var currentAmplitude: Float = 0

    private let synthesizer = AVSpeechSynthesizer()
    private var onComplete: (() -> Void)?
    private var amplitudeTimer: Timer?
    private var delegateSet = false

    nonisolated override init() {
        super.init()
    }

    private func ensureDelegate() {
        guard !delegateSet else { return }
        delegateSet = true
        synthesizer.delegate = self
    }

    func speak(_ text: String, onComplete: (() -> Void)? = nil) {
        ensureDelegate()
        stop()
        self.onComplete = onComplete

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1.0
        utterance.volume = 1.0

        isSpeaking = true
        startAmplitudePolling()
        synthesizer.speak(utterance)
        log.info("TTS started speaking")
    }

    func stop() {
        guard isSpeaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        stopAmplitudePolling()
        isSpeaking = false
        currentAmplitude = 0
        onComplete = nil
        log.info("TTS stopped")
    }

    private func startAmplitudePolling() {
        amplitudeTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.isSpeaking else { return }
                // Simulate amplitude variation while speaking since AVSpeechSynthesizer
                // doesn't expose audio levels directly.
                self.currentAmplitude = Float.random(in: 0.3...0.8)
            }
        }
    }

    private func stopAmplitudePolling() {
        amplitudeTimer?.invalidate()
        amplitudeTimer = nil
    }
}

extension TTSEngine: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.stopAmplitudePolling()
            self.isSpeaking = false
            self.currentAmplitude = 0
            log.info("TTS utterance finished")
            let completion = self.onComplete
            self.onComplete = nil
            completion?()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.stopAmplitudePolling()
            self.isSpeaking = false
            self.currentAmplitude = 0
            log.info("TTS utterance cancelled")
            self.onComplete = nil
        }
    }
}
