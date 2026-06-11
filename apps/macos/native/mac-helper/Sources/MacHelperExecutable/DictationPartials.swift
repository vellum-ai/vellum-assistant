import AVFoundation
import Foundation
import Speech

enum DictationPartialsError: LocalizedError {
    case recognizerUnavailable
    case noInputDevice

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            return "speech recognizer unavailable"
        case .noInputDevice:
            return "no audio input device"
        }
    }
}

/// Streams local `SFSpeechRecognizer` partial transcriptions while dictation
/// records — the same role the recognizer played in the legacy Swift client.
///
/// This is the universal live-transcript source for the dictation overlay:
/// it needs no network topology at all, so it works for platform-managed
/// assistants whose runtime traffic rides the platform proxy (where the
/// renderer has no gateway WebSocket to stream against). When daemon
/// streaming STT *is* reachable, the renderer prefers those partials and
/// never starts this session.
///
/// Capture runs in the helper process: a tap on `AVAudioEngine`'s input node
/// feeds an `SFSpeechAudioBufferRecognitionRequest`, and every recognition
/// callback emits the cumulative best transcription via `emit`. The mic can
/// be captured here concurrently with the renderer's `MediaRecorder` — macOS
/// allows multiple taps on the default input.
final class DictationPartialsSession: @unchecked Sendable {
    private let audioEngine = AVAudioEngine()
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private var stopped = false
    private let emit: (String) -> Void

    init(emit: @escaping (String) -> Void) {
        self.emit = emit
    }

    func start() throws {
        guard
            let recognizer = SFSpeechRecognizer()
                ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
            recognizer.isAvailable
        else {
            throw DictationPartialsError.recognizerUnavailable
        }

        request.shouldReportPartialResults = true
        // Pin recognition on-device when the locale has a local model:
        // dictation audio shouldn't leave the machine, and it keeps the
        // transcript working offline. Locales without an on-device model
        // stay on Apple's server path — forcing the flag there would fail
        // recognition outright instead of degrading.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw DictationPartialsError.noInputDevice
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [request] buffer, _ in
            request.append(buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, _ in
            guard let self, !self.stopped, let result else { return }
            self.emit(result.bestTranscription.formattedString)
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        request.endAudio()
        task?.cancel()
        task = nil
    }
}
