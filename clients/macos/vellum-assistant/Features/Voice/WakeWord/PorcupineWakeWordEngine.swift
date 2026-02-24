import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "PorcupineWakeWordEngine")

/// Wake word engine backed by Porcupine's C SDK via `PorcupineBinding`.
///
/// Loads `libpv_porcupine.dylib` at runtime, resolves model and keyword
/// files from the app bundle, and processes 16 kHz Int16 PCM audio in
/// 512-sample frames. Thread-safe: `start()` and `stop()` are called from
/// the main thread; `processAudioFrame(_:)` runs on the audio thread.
final class PorcupineWakeWordEngine: WakeWordEngine {

    var onWakeWordDetected: ((Float) -> Void)?

    private(set) var isRunning = false

    /// Detection sensitivity (0.0 = least sensitive, 1.0 = most sensitive).
    let sensitivity: Float

    /// Built-in keyword name (e.g. "computer") or absolute path to a custom .ppn file.
    let keyword: String

    private var binding: PorcupineBinding?
    private var frameBuffer: [Int16] = []
    private var frameLength: Int = 512

    /// Guards `binding` and `frameBuffer` for thread safety between
    /// the main thread (`start`/`stop`) and the audio thread (`processAudioFrame`).
    private var lock = os_unfair_lock()

    /// Whether an error has already been logged during `processAudioFrame` to
    /// avoid flooding the log on every frame.
    private var hasLoggedProcessError = false

    init(sensitivity: Float = 0.5, keyword: String = "computer") {
        self.sensitivity = sensitivity
        self.keyword = keyword
    }

    // MARK: - WakeWordEngine

    func start() throws {
        guard !isRunning else { return }

        // 1. Access key
        guard let accessKey = APIKeyManager.getKey(for: "picovoice") else {
            log.warning("Picovoice access key not found in keychain — wake word detection disabled")
            return
        }

        // 2. Dylib path
        guard let frameworksPath = Bundle.main.privateFrameworksPath else {
            log.warning("Bundle.main.privateFrameworksPath is nil — wake word detection disabled")
            return
        }
        let dylibPath = (frameworksPath as NSString).appendingPathComponent("libpv_porcupine.dylib")
        guard FileManager.default.fileExists(atPath: dylibPath) else {
            log.warning("libpv_porcupine.dylib not found at \(dylibPath) — wake word detection disabled")
            return
        }

        // 3. Create binding (loads dylib, resolves symbols)
        let newBinding: PorcupineBinding
        do {
            newBinding = try PorcupineBinding(dylibPath: dylibPath)
        } catch {
            log.error("Failed to load PorcupineBinding: \(error)")
            return
        }

        // 4. Model path
        guard let resourceURL = Bundle.main.resourceURL else {
            log.error("Bundle.main.resourceURL is nil — cannot locate Porcupine model")
            return
        }
        let modelPath = resourceURL.appendingPathComponent("porcupine_params.pv").path
        guard FileManager.default.fileExists(atPath: modelPath) else {
            log.error("Porcupine model not found at \(modelPath)")
            return
        }

        // 5. Keyword path
        let keywordPath: String
        let keywordDir = resourceURL.appendingPathComponent("porcupine-keywords")
        let builtinPath = keywordDir.appendingPathComponent(self.keyword.lowercased() + "_mac.ppn").path
        if FileManager.default.fileExists(atPath: builtinPath) {
            keywordPath = builtinPath
        } else if self.keyword.hasPrefix("/") && FileManager.default.fileExists(atPath: self.keyword) {
            // Treat keyword as an absolute path to a custom .ppn file
            keywordPath = self.keyword
        } else {
            log.error("Keyword file not found: tried \(builtinPath) and absolute path \(self.keyword)")
            return
        }

        // 6. Initialize Porcupine engine
        do {
            try newBinding.initialize(
                accessKey: accessKey,
                modelPath: modelPath,
                keywordPaths: [keywordPath],
                sensitivities: [self.sensitivity]
            )
        } catch {
            log.error("Failed to initialize Porcupine engine: \(error)")
            return
        }

        // 7. Query actual frame length from binding
        let actualFrameLength = Int(newBinding.frameLength)

        // 8. Commit state
        withLock {
            self.binding = newBinding
            self.frameBuffer = []
            self.frameLength = actualFrameLength
            self.hasLoggedProcessError = false
        }
        isRunning = true
        log.info("PorcupineWakeWordEngine started (keyword: \(self.keyword), sensitivity: \(self.sensitivity), version: \(newBinding.version))")
    }

    func stop() {
        guard isRunning else { return }
        withLock {
            binding?.delete()
            binding = nil
            frameBuffer = []
        }
        isRunning = false
        log.info("PorcupineWakeWordEngine stopped")
    }

    // MARK: - Audio processing (audio thread)

    func processAudioFrame(_ frame: [Int16]) {
        var shouldNotify = false
        withLock {
            guard binding != nil else { return }
            frameBuffer.append(contentsOf: frame)

            while frameBuffer.count >= frameLength {
                let chunk = Array(frameBuffer.prefix(frameLength))
                frameBuffer.removeFirst(frameLength)

                do {
                    let keywordIndex = try binding!.process(pcm: chunk)
                    if keywordIndex >= 0 {
                        shouldNotify = true
                    }
                } catch {
                    if !hasLoggedProcessError {
                        hasLoggedProcessError = true
                        log.error("Porcupine process error (further errors suppressed): \(error)")
                    }
                    // Stop processing further frames this call
                    return
                }
            }
        }
        if shouldNotify {
            onWakeWordDetected?(1.0)
        }
    }

    // MARK: - Lock helpers

    private func withLock<T>(_ body: () -> T) -> T {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return body()
    }
}
