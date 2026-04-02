import AVFoundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AudioEngineController")

/// Encapsulates all `AVAudioEngine` and `inputNode` interactions on a dedicated
/// serial dispatch queue, keeping them off the main thread.
///
/// `AVAudioEngine.inputNode` internally performs a synchronous dispatch to an
/// audio-subsystem queue. When that queue is contended (hardware state changes,
/// Bluetooth negotiation, coreaudiod latency), the wait can exceed 2 seconds.
/// By routing every engine operation through a private serial queue, the main
/// thread is never blocked.
///
/// References:
/// - Apple docs: installTap "may invoke the tapBlock on a thread other than the main thread"
/// - Sentry issue VELLUM-ASSISTANT-MACOS-CW (AVAudioEngine.inputNode → _dispatch_sync_f_slow)
final class AudioEngineController: @unchecked Sendable {

    private lazy var audioEngine = AVAudioEngine()
    private let queue = DispatchQueue(label: "com.vellum.audioEngine", qos: .userInitiated)

    // MARK: - Input Node Format

    /// Returns the input node's output format for bus 0, accessed off the main thread.
    /// Returns `nil` if the format has zero channels or zero sample rate.
    func inputNodeFormat() -> AVAudioFormat? {
        queue.sync {
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
    func installTap(
        bufferSize: AVAudioFrameCount,
        format: AVAudioFormat?,
        block: @escaping AVAudioNodeTapBlock
    ) {
        queue.sync { [weak self] in
            guard let self else { return }
            let inputNode = self.audioEngine.inputNode
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: format, block: block)
        }
    }

    /// Remove the tap on bus 0 from the input node.
    func removeTap() {
        queue.sync { [weak self] in
            guard let self else { return }
            self.audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    // MARK: - Engine Lifecycle

    func prepare() {
        queue.sync { [weak self] in
            self?.audioEngine.prepare()
        }
    }

    func start() throws {
        try queue.sync { [weak self] in
            try self?.audioEngine.start()
        }
    }

    func stop() {
        queue.sync { [weak self] in
            guard let self else { return }
            if self.audioEngine.isRunning {
                self.audioEngine.stop()
            }
        }
    }

    /// Stop the engine unconditionally (even if `isRunning` is false).
    func forceStop() {
        queue.sync { [weak self] in
            self?.audioEngine.stop()
        }
    }

    var isRunning: Bool {
        queue.sync { [weak self] in
            self?.audioEngine.isRunning ?? false
        }
    }

    /// Stop the engine, remove tap, and reset internal state.
    func reset() {
        queue.sync { [weak self] in
            guard let self else { return }
            self.audioEngine.stop()
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.audioEngine.reset()
        }
    }

    /// Stop, remove tap, and optionally cancel a recognition task/request.
    /// This is the shared teardown path that replaces inline cleanup sequences.
    func tearDown() {
        queue.sync { [weak self] in
            guard let self else { return }
            self.audioEngine.stop()
            self.audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    // MARK: - Combined Operations

    /// Prepare and start the engine. Returns `true` on success.
    /// On failure, removes tap and returns `false`.
    @discardableResult
    func prepareAndStart() -> Bool {
        queue.sync { [weak self] -> Bool in
            guard let self else { return false }
            self.audioEngine.prepare()
            do {
                try self.audioEngine.start()
                return true
            } catch {
                log.error("Failed to start audio engine: \(error.localizedDescription)")
                self.audioEngine.inputNode.removeTap(onBus: 0)
                return false
            }
        }
    }

    /// Stop the engine and remove the input tap (if running).
    func stopAndRemoveTap() {
        queue.sync { [weak self] in
            guard let self else { return }
            if self.audioEngine.isRunning {
                self.audioEngine.stop()
            }
            self.audioEngine.inputNode.removeTap(onBus: 0)
        }
    }
}
