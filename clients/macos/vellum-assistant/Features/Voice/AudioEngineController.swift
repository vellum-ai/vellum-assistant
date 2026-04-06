import AVFoundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AudioEngineController")

/// Encapsulates all `AVAudioEngine` and `inputNode` interactions on a dedicated
/// serial dispatch queue, keeping them off the main thread.
///
/// `AVAudioEngine.inputNode` internally performs a synchronous dispatch to an
/// audio-subsystem queue. When that queue is contended (hardware state changes,
/// Bluetooth negotiation, coreaudiod latency), the wait can exceed 2 seconds.
///
/// Fire-and-forget operations (`stop`, `reset`) use `queue.async` so the caller
/// never blocks. Methods that require ordering guarantees (`tearDown`,
/// `stopAndRemoveTap`, `installTapAndStart`) use `queue.sync`. Callers should
/// ensure `prewarm()` has run first so `inputNode` is already initialized and
/// sync calls complete in sub-milliseconds.
///
/// See: https://developer.apple.com/documentation/avfaudio/avaudionode/1387122-installtap
final class AudioEngineController: @unchecked Sendable {

    private let audioEngine = AVAudioEngine()
    private let queue: DispatchQueue

    init(label: String = "com.vellum.audioEngine") {
        self.queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    // MARK: - Pre-warm

    /// Touch `inputNode` to force lazy initialization of the audio subsystem.
    func prewarm() {
        queue.async { [weak self] in
            guard let self else { return }
            let _ = self.audioEngine.inputNode
            log.info("Audio engine pre-warmed (off main thread)")
        }
    }

    // MARK: - Engine Lifecycle

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            if self.audioEngine.isRunning {
                self.audioEngine.stop()
            }
        }
    }

    /// Stop the engine, remove tap, and reset internal state.
    func reset() {
        queue.async { [weak self] in
            guard let self else { return }
            self.audioEngine.stop()
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.audioEngine.reset()
        }
    }

    /// Stop the engine and remove the input tap.
    /// Uses `sync` because callers depend on the tap being removed before
    /// they call `recognitionRequest?.endAudio()` or `recognitionTask?.cancel()`.
    func tearDown() {
        queue.sync { [self] in
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    // MARK: - Combined Operations

    /// Atomically validates audio input, installs a tap with `nil` format, and
    /// starts the engine in a single synchronous dispatch to the audio queue.
    ///
    /// Passing `nil` for `installTap`'s format parameter lets AVAudioEngine use
    /// its own internal hardware format, which is always self-consistent. This
    /// prevents `NSInternalInconsistencyException` crashes caused by
    /// `format.sampleRate != hwFormat.sampleRate` — the cached format from
    /// `outputFormat(forBus:)` can diverge from the engine's internal hardware
    /// format after audio route changes (Bluetooth, USB mic, AirPods mode
    /// switch), even within a single synchronous block.
    ///
    /// The format validation (channels > 0, sampleRate > 0) is kept as a
    /// pre-check to detect "no audio input available" — but the validated format
    /// is **not** forwarded to `installTap`.
    ///
    /// Returns `true` on success, or `false` if no audio input is available or
    /// the engine fails to start.
    ///
    /// See: https://developer.apple.com/documentation/avfaudio/avaudionode/installtap(onbus:buffersize:format:block:)
    func installTapAndStart(
        bufferSize: AVAudioFrameCount,
        block: @escaping AVAudioNodeTapBlock
    ) -> Bool {
        queue.sync { [self] in
            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else {
                log.error("Invalid audio format — channels: \(format.channelCount), sampleRate: \(format.sampleRate)")
                return false
            }

            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: nil, block: block)

            audioEngine.prepare()
            do {
                try audioEngine.start()
                return true
            } catch {
                log.error("Failed to start audio engine: \(error.localizedDescription)")
                inputNode.removeTap(onBus: 0)
                return false
            }
        }
    }

    /// Stop the engine and remove the input tap (if running).
    /// Uses `sync` because callers depend on the tap being removed before
    /// they call `recognitionRequest?.endAudio()` — appending audio after
    /// `endAudio()` violates `SFSpeechAudioBufferRecognitionRequest`'s contract.
    func stopAndRemoveTap() {
        queue.sync { [self] in
            if audioEngine.isRunning {
                audioEngine.stop()
            }
            audioEngine.inputNode.removeTap(onBus: 0)
        }
    }
}
