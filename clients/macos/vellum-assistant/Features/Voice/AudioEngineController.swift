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
/// Fire-and-forget operations (`installTap`, `removeTap`, `stop`, `reset`)
/// use `queue.async` so the caller never blocks. Methods that return a value
/// (`inputNodeFormat`, `prepareAndStart`) or that require ordering guarantees
/// (`tearDown`, `stopAndRemoveTap` — callers call `endAudio()` immediately
/// after) use `queue.sync`. Callers should ensure `prewarm()` has run first
/// so `inputNode` is already initialized and sync calls complete in
/// sub-milliseconds.
///
/// See: https://developer.apple.com/documentation/avfaudio/avaudionode/1387122-installtap
final class AudioEngineController: @unchecked Sendable {

    private let audioEngine = AVAudioEngine()
    private let queue: DispatchQueue

    init(label: String = "com.vellum.audioEngine") {
        self.queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    // MARK: - Input Node Format

    /// Returns the input node's output format for bus 0.
    /// Returns `nil` if the format has zero channels or zero sample rate.
    func inputNodeFormat() -> AVAudioFormat? {
        queue.sync { [self] in
            let format = audioEngine.inputNode.outputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else { return nil }
            return format
        }
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

    // MARK: - Tap Management

    /// Remove any existing tap on bus 0, then install a new one.
    /// Uses `async` — the next `queue.sync` call (e.g. `prepareAndStart`) will
    /// wait for this to complete thanks to serial queue ordering.
    func installTap(
        bufferSize: AVAudioFrameCount,
        format: AVAudioFormat?,
        block: @escaping AVAudioNodeTapBlock
    ) {
        queue.async { [weak self] in
            guard let self else { return }
            let inputNode = self.audioEngine.inputNode
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: format, block: block)
        }
    }

    /// Remove the tap on bus 0 from the input node.
    func removeTap() {
        queue.async { [weak self] in
            guard let self else { return }
            self.audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    // MARK: - Engine Lifecycle

    func prepare() {
        queue.async { [weak self] in
            self?.audioEngine.prepare()
        }
    }

    func start() throws {
        try queue.sync { [self] in
            try audioEngine.start()
        }
    }

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

    /// Atomically reads the input format, installs a tap, and starts the engine
    /// in a single synchronous dispatch to the audio queue.
    ///
    /// Eliminates the TOCTOU race where the format read by `inputNodeFormat()`
    /// becomes stale before the separate `installTap()` async block executes —
    /// which crashes with `NSInternalInconsistencyException` when the hardware
    /// format changes between calls (common on first use after permission grant).
    ///
    /// Returns `true` on success, or `false` if the format is invalid or the
    /// engine fails to start.
    ///
    /// See: https://developer.apple.com/documentation/avfaudio/avaudionode/1387122-installtap
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
            inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: format, block: block)

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

    /// Prepare and start the engine. Returns `true` on success.
    /// On failure, removes tap and returns `false`.
    @discardableResult
    func prepareAndStart() -> Bool {
        queue.sync { [self] in
            audioEngine.prepare()
            do {
                try audioEngine.start()
                return true
            } catch {
                log.error("Failed to start audio engine: \(error.localizedDescription)")
                audioEngine.inputNode.removeTap(onBus: 0)
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
