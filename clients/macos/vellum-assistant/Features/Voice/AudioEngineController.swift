import AVFoundation
import AVFAudio
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
/// Listens for `AVAudioEngineConfigurationChange` notifications to re-warm
/// `inputNode` after audio route changes (Bluetooth connect/disconnect,
/// AirPods mode switch, USB mic plug/unplug).
///
/// See: https://developer.apple.com/documentation/avfaudio/avaudionode/1387122-installtap
final class AudioEngineController: @unchecked Sendable {

    private let audioEngine = AVAudioEngine()
    private let queue: DispatchQueue
    private var configChangeObserver: (any NSObjectProtocol)?

    init(label: String = "com.vellum.audioEngine") {
        self.queue = DispatchQueue(label: label, qos: .userInitiated)
        observeConfigurationChanges()
    }

    deinit {
        if let observer = configChangeObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Configuration Change Monitoring

    /// Re-prewarm `inputNode` when the audio hardware configuration changes
    /// (Bluetooth device connect/disconnect, USB mic plug/unplug, AirPods
    /// mode switch). Keeps the cached inputNode format fresh so subsequent
    /// `installTapAndStart` calls complete in sub-milliseconds.
    ///
    /// See: https://developer.apple.com/documentation/avfaudio/avaudioengine/1386063-configurationchangenotification
    private func observeConfigurationChanges() {
        configChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: audioEngine,
            queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                log.info("Audio configuration changed — skipping re-warm (mic not authorized)")
                return
            }
            log.info("Audio configuration changed — re-warming inputNode")
            self.queue.async {
                let _ = self.audioEngine.inputNode
                log.info("Audio engine re-warmed after configuration change")
            }
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

    /// Atomically resets the engine, validates audio input, installs a tap
    /// with the freshly-queried hardware format, and starts the engine in a
    /// single synchronous dispatch to the audio queue.
    ///
    /// After audio-route changes (Bluetooth, USB mic, AirPods mode switch)
    /// the format cached inside `AVAudioInputNode` can diverge from the
    /// engine's actual hardware format. Both `outputFormat(forBus:)` **and**
    /// a `nil` format argument to `installTap` resolve to this stale value,
    /// causing:
    ///
    ///     "Failed to create tap due to format mismatch,
    ///      <AVAudioFormat …: 2 ch, 44100 Hz, Float32, deinterleaved>"
    ///
    /// Calling `audioEngine.reset()` before re-querying forces the engine to
    /// discard its cached graph state and re-read the hardware on the next
    /// access. The fresh format is then passed **explicitly** to `installTap`
    /// so the tap, the node, and the engine all agree.
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
            installTapAndStartImpl(bufferSize: bufferSize, block: block)
        }
    }

    /// Non-blocking variant of `installTapAndStart` using Swift concurrency.
    /// Dispatches to the audio queue asynchronously and returns the result via
    /// async/await, keeping the caller's thread free during engine initialization.
    ///
    /// Use this for latency-sensitive flows (e.g. PTT dictation) where showing
    /// immediate UI feedback before the engine is ready improves perceived
    /// responsiveness.
    func installTapAndStartAsync(
        bufferSize: AVAudioFrameCount,
        block: @escaping AVAudioNodeTapBlock
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                let success = installTapAndStartImpl(bufferSize: bufferSize, block: block)
                continuation.resume(returning: success)
            }
        }
    }

    /// Shared implementation for both sync and async tap+start paths.
    ///
    /// Stops, removes any existing tap, and resets the engine before querying
    /// `outputFormat(forBus:)` so the returned format reflects the current
    /// hardware — not a stale cache from a previous audio route.
    private func installTapAndStartImpl(
        bufferSize: AVAudioFrameCount,
        block: @escaping AVAudioNodeTapBlock
    ) -> Bool {
        let inputNode = audioEngine.inputNode

        // Stop, remove any existing tap, and reset the engine so that
        // outputFormat(forBus:) returns a value consistent with the
        // current hardware — not a stale cache from a previous route.
        audioEngine.stop()
        inputNode.removeTap(onBus: 0)
        audioEngine.reset()

        let format = inputNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            log.error("Invalid audio format — channels: \(format.channelCount), sampleRate: \(format.sampleRate)")
            return false
        }

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
