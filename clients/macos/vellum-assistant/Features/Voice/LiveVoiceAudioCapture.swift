import AVFoundation
import Foundation

struct LiveVoiceAudioCaptureChunk: Equatable {
    let pcm16LittleEndian: Data
    let sampleRate: Int
    let channelCount: Int
    let frameCount: Int
    let amplitude: Float
}

protocol LiveVoiceAudioEngineControlling: AnyObject {
    func installTapAndStart(
        bufferSize: AVAudioFrameCount,
        block: @escaping AVAudioNodeTapBlock
    ) -> Bool
    func stopAndRemoveTap()
    func stop()
}

extension AudioEngineController: LiveVoiceAudioEngineControlling {}

protocol LiveVoiceMicrophonePermissioning {
    func requestMicrophoneAccess() async -> Bool
}

struct SystemLiveVoiceMicrophonePermissionRequester: LiveVoiceMicrophonePermissioning {
    func requestMicrophoneAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            PermissionManager.requestMicrophoneAccess()
            return false
        @unknown default:
            PermissionManager.requestMicrophoneAccess()
            return false
        }
    }
}

final class LiveVoiceAudioCapture {
    typealias ChunkHandler = (LiveVoiceAudioCaptureChunk) -> Void
    typealias AmplitudeHandler = (Float) -> Void

    private enum CaptureState {
        case idle
        case starting
        case running
        case shutDown
    }

    private let engineController: any LiveVoiceAudioEngineControlling
    private let microphonePermission: any LiveVoiceMicrophonePermissioning
    private let bufferSize: AVAudioFrameCount
    private let lock = NSLock()

    private var state: CaptureState = .idle
    private var generation: UInt64 = 0
    private var chunkHandler: ChunkHandler?
    private var amplitudeHandler: AmplitudeHandler?

    init(
        engineController: any LiveVoiceAudioEngineControlling = AudioEngineController(label: "com.vellum.audioEngine.liveVoiceCapture"),
        microphonePermission: any LiveVoiceMicrophonePermissioning = SystemLiveVoiceMicrophonePermissionRequester(),
        bufferSize: AVAudioFrameCount = 1024
    ) {
        self.engineController = engineController
        self.microphonePermission = microphonePermission
        self.bufferSize = bufferSize
    }

    @discardableResult
    func start(
        onChunk: @escaping ChunkHandler,
        onAmplitude: AmplitudeHandler? = nil
    ) async -> Bool {
        let captureGeneration: UInt64
        switch beginStart(onChunk: onChunk, onAmplitude: onAmplitude) {
        case .alreadyActive:
            return true
        case .shutDown:
            return false
        case .starting(let generation):
            captureGeneration = generation
        }

        let microphoneGranted = await microphonePermission.requestMicrophoneAccess()
        guard microphoneGranted else {
            resetStartingCaptureIfCurrent(captureGeneration)
            return false
        }

        guard isCurrentStartingCapture(captureGeneration) else {
            return false
        }

        let tapBlock: AVAudioNodeTapBlock = { [weak self] buffer, _ in
            self?.handle(buffer: buffer, generation: captureGeneration)
        }

        let started = engineController.installTapAndStart(bufferSize: bufferSize, block: tapBlock)
        guard started else {
            resetStartingCaptureIfCurrent(captureGeneration)
            return false
        }

        let isCurrentStart = finishStartIfCurrent(captureGeneration)

        if !isCurrentStart {
            engineController.stopAndRemoveTap()
        }

        return isCurrentStart
    }

    func stop() {
        let handlerToReset: AmplitudeHandler?
        let shouldRemoveTap: Bool

        lock.lock()
        switch state {
        case .starting:
            generation &+= 1
            state = .idle
            chunkHandler = nil
            handlerToReset = amplitudeHandler
            amplitudeHandler = nil
            shouldRemoveTap = false
        case .running:
            generation &+= 1
            state = .idle
            chunkHandler = nil
            handlerToReset = amplitudeHandler
            amplitudeHandler = nil
            shouldRemoveTap = true
        case .idle, .shutDown:
            handlerToReset = nil
            shouldRemoveTap = false
        }
        lock.unlock()

        if shouldRemoveTap {
            engineController.stopAndRemoveTap()
        }
        handlerToReset?(0)
    }

    func shutdown() {
        let handlerToReset: AmplitudeHandler?
        let shouldRemoveTap: Bool
        let shouldStopEngine: Bool

        lock.lock()
        switch state {
        case .shutDown:
            handlerToReset = nil
            shouldRemoveTap = false
            shouldStopEngine = false
        case .idle, .starting, .running:
            shouldRemoveTap = state == .running
            shouldStopEngine = true
            generation &+= 1
            state = .shutDown
            chunkHandler = nil
            handlerToReset = amplitudeHandler
            amplitudeHandler = nil
        }
        lock.unlock()

        if shouldRemoveTap {
            engineController.stopAndRemoveTap()
        }
        if shouldStopEngine {
            engineController.stop()
            handlerToReset?(0)
        }
    }

    private enum StartAttempt {
        case alreadyActive
        case shutDown
        case starting(UInt64)
    }

    private func beginStart(
        onChunk: @escaping ChunkHandler,
        onAmplitude: AmplitudeHandler?
    ) -> StartAttempt {
        lock.lock()
        defer { lock.unlock() }

        switch state {
        case .starting, .running:
            return .alreadyActive
        case .shutDown:
            return .shutDown
        case .idle:
            generation &+= 1
            state = .starting
            chunkHandler = onChunk
            amplitudeHandler = onAmplitude
            return .starting(generation)
        }
    }

    private func handle(buffer: AVAudioPCMBuffer, generation captureGeneration: UInt64) {
        guard let chunk = Self.makeChunk(from: buffer) else { return }

        let chunkHandler: ChunkHandler?
        let amplitudeHandler: AmplitudeHandler?

        lock.lock()
        let acceptsBuffer = generation == captureGeneration && (state == .starting || state == .running)
        if acceptsBuffer {
            chunkHandler = self.chunkHandler
            amplitudeHandler = self.amplitudeHandler
        } else {
            chunkHandler = nil
            amplitudeHandler = nil
        }
        lock.unlock()

        chunkHandler?(chunk)
        amplitudeHandler?(chunk.amplitude)
    }

    private func isCurrentStartingCapture(_ captureGeneration: UInt64) -> Bool {
        lock.lock()
        let isCurrent = generation == captureGeneration && state == .starting
        lock.unlock()
        return isCurrent
    }

    private func finishStartIfCurrent(_ captureGeneration: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        let isCurrent = generation == captureGeneration && state == .starting
        if isCurrent {
            state = .running
        }
        return isCurrent
    }

    private func resetStartingCaptureIfCurrent(_ captureGeneration: UInt64) {
        let handlerToReset: AmplitudeHandler?

        lock.lock()
        if generation == captureGeneration, state == .starting {
            state = .idle
            chunkHandler = nil
            handlerToReset = amplitudeHandler
            amplitudeHandler = nil
        } else {
            handlerToReset = nil
        }
        lock.unlock()

        handlerToReset?(0)
    }

    static func makeChunk(from buffer: AVAudioPCMBuffer) -> LiveVoiceAudioCaptureChunk? {
        guard let channelData = buffer.floatChannelData else { return nil }

        let frameCount = Int(buffer.frameLength)
        let inputChannelCount = Int(buffer.format.channelCount)
        let sampleRate = Int(buffer.format.sampleRate.rounded())
        guard frameCount > 0, inputChannelCount > 0, sampleRate > 0 else { return nil }

        var pcmData = Data(capacity: frameCount * MemoryLayout<Int16>.size)
        var squareSum: Float = 0
        let channelZero = channelData[0]

        for frame in 0..<frameCount {
            let sourceIndex = buffer.format.isInterleaved ? frame * inputChannelCount : frame
            let clamped = max(-1, min(1, channelZero[sourceIndex]))
            let sample = pcmInt16Sample(from: clamped)
            squareSum += clamped * clamped
            withUnsafeBytes(of: sample.littleEndian) { pcmData.append(contentsOf: $0) }
        }

        let rms = sqrt(squareSum / Float(frameCount))
        let amplitude = min(rms * 5, 1)

        return LiveVoiceAudioCaptureChunk(
            pcm16LittleEndian: pcmData,
            sampleRate: sampleRate,
            channelCount: 1,
            frameCount: frameCount,
            amplitude: amplitude
        )
    }

    static func pcmInt16Sample(from sample: Float) -> Int16 {
        let clamped = max(-1, min(1, sample))
        if clamped <= -1 {
            return Int16.min
        }
        if clamped >= 1 {
            return Int16.max
        }

        let scale: Float = clamped < 0 ? 32768 : 32767
        return Int16((clamped * scale).rounded(.towardZero))
    }
}
