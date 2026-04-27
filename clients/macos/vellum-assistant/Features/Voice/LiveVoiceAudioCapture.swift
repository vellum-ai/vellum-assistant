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
    private var pcmConverter = LiveVoicePCM16kMonoConverter()

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
            pcmConverter.reset()
            shouldRemoveTap = false
        case .running:
            generation &+= 1
            state = .idle
            chunkHandler = nil
            handlerToReset = amplitudeHandler
            amplitudeHandler = nil
            pcmConverter.reset()
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
            pcmConverter.reset()
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
            pcmConverter.reset()
            return .starting(generation)
        }
    }

    private func handle(buffer: AVAudioPCMBuffer, generation captureGeneration: UInt64) {
        let chunkHandler: ChunkHandler?
        let amplitudeHandler: AmplitudeHandler?
        let chunk: LiveVoiceAudioCaptureChunk?

        lock.lock()
        let acceptsBuffer = generation == captureGeneration && (state == .starting || state == .running)
        if acceptsBuffer {
            chunk = pcmConverter.makeChunk(from: buffer)
            chunkHandler = self.chunkHandler
            amplitudeHandler = self.amplitudeHandler
        } else {
            chunk = nil
            chunkHandler = nil
            amplitudeHandler = nil
        }
        lock.unlock()

        guard let chunk else { return }
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
            pcmConverter.reset()
        } else {
            handlerToReset = nil
        }
        lock.unlock()

        handlerToReset?(0)
    }

    static func makeChunk(from buffer: AVAudioPCMBuffer) -> LiveVoiceAudioCaptureChunk? {
        var converter = LiveVoicePCM16kMonoConverter()
        return converter.makeChunk(from: buffer)
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

private struct LiveVoicePCM16kMonoConverter {
    private static let targetSampleRate = 16_000
    private static let targetSampleRateDouble = Double(targetSampleRate)

    private var sourceSampleRate: Double?
    private var nextSourceFramePosition: Double = 0

    mutating func reset() {
        sourceSampleRate = nil
        nextSourceFramePosition = 0
    }

    mutating func makeChunk(from buffer: AVAudioPCMBuffer) -> LiveVoiceAudioCaptureChunk? {
        guard let channelData = buffer.floatChannelData else { return nil }

        let frameCount = Int(buffer.frameLength)
        let inputChannelCount = Int(buffer.format.channelCount)
        let inputSampleRate = buffer.format.sampleRate
        guard frameCount > 0, inputChannelCount > 0, inputSampleRate > 0 else { return nil }

        if sourceSampleRate != inputSampleRate {
            sourceSampleRate = inputSampleRate
            nextSourceFramePosition = 0
        }

        let samples = makeResampledMonoSamples(
            channelData: channelData,
            frameCount: frameCount,
            channelCount: inputChannelCount,
            isInterleaved: buffer.format.isInterleaved,
            inputSampleRate: inputSampleRate
        )
        guard !samples.isEmpty else { return nil }

        var pcmData = Data(capacity: samples.count * MemoryLayout<Int16>.size)
        var squareSum: Float = 0

        for sample in samples {
            let clamped = max(-1, min(1, sample))
            let pcmSample = LiveVoiceAudioCapture.pcmInt16Sample(from: clamped)
            squareSum += clamped * clamped
            withUnsafeBytes(of: pcmSample.littleEndian) { pcmData.append(contentsOf: $0) }
        }

        let rms = sqrt(squareSum / Float(samples.count))
        let amplitude = min(rms * 5, 1)

        return LiveVoiceAudioCaptureChunk(
            pcm16LittleEndian: pcmData,
            sampleRate: Self.targetSampleRate,
            channelCount: 1,
            frameCount: samples.count,
            amplitude: amplitude
        )
    }

    private mutating func makeResampledMonoSamples(
        channelData: UnsafePointer<UnsafeMutablePointer<Float>>,
        frameCount: Int,
        channelCount: Int,
        isInterleaved: Bool,
        inputSampleRate: Double
    ) -> [Float] {
        let sourceFramesPerOutputFrame = inputSampleRate / Self.targetSampleRateDouble
        var samples: [Float] = []
        samples.reserveCapacity(max(1, Int((Double(frameCount) / sourceFramesPerOutputFrame).rounded(.up))))

        while nextSourceFramePosition < Double(frameCount) {
            let lowerFrame = min(Int(nextSourceFramePosition.rounded(.down)), frameCount - 1)
            let upperFrame = min(lowerFrame + 1, frameCount - 1)
            let fraction = Float(nextSourceFramePosition - Double(lowerFrame))
            let lowerSample = monoSample(
                channelData: channelData,
                frame: lowerFrame,
                channelCount: channelCount,
                isInterleaved: isInterleaved
            )
            let upperSample = monoSample(
                channelData: channelData,
                frame: upperFrame,
                channelCount: channelCount,
                isInterleaved: isInterleaved
            )
            samples.append(lowerSample + (upperSample - lowerSample) * fraction)
            nextSourceFramePosition += sourceFramesPerOutputFrame
        }

        nextSourceFramePosition -= Double(frameCount)
        if nextSourceFramePosition < 0 {
            nextSourceFramePosition = 0
        }
        return samples
    }

    private func monoSample(
        channelData: UnsafePointer<UnsafeMutablePointer<Float>>,
        frame: Int,
        channelCount: Int,
        isInterleaved: Bool
    ) -> Float {
        var sum: Float = 0
        if isInterleaved {
            let baseIndex = frame * channelCount
            for channel in 0..<channelCount {
                sum += channelData[0][baseIndex + channel]
            }
        } else {
            for channel in 0..<channelCount {
                sum += channelData[channel][frame]
            }
        }
        return sum / Float(channelCount)
    }
}
