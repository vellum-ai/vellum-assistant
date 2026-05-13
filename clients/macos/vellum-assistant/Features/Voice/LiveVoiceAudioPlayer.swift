import AVFoundation
import Foundation
import Observation

struct LiveVoiceAudioChunk: Equatable {
    let data: Data
    let mimeType: String
    let sampleRate: Int
    let channels: Int

    init(
        data: Data,
        mimeType: String,
        sampleRate: Int,
        channels: Int = 1
    ) {
        self.data = data
        self.mimeType = mimeType
        self.sampleRate = sampleRate
        self.channels = channels
    }

    var isPCM: Bool {
        mimeType.lowercased().hasPrefix("audio/pcm")
    }
}

enum LiveVoiceAudioStopReason: Equatable {
    case interrupt
    case end
    case sessionError
    case manual
}

enum LiveVoiceAudioPlaybackState: Equatable {
    case idle
    case playing
    case stopped(LiveVoiceAudioStopReason)
    case failed(String)
}

@MainActor
protocol LiveVoiceAudioOutput: AnyObject {
    func play(
        _ chunk: LiveVoiceAudioChunk,
        completion: @escaping @MainActor (Result<Void, Error>) -> Void
    )
    func stop()
}

enum LiveVoiceAudioOutputError: Error, LocalizedError, Equatable {
    case malformedPCMData
    case unsupportedPCMFormat
    case playbackStartFailed
    case playbackFinishedUnsuccessfully
    case audioEngineStartFailed(String)
    case decodingFailed(String)

    var errorDescription: String? {
        switch self {
        case .malformedPCMData:
            "Malformed PCM audio data"
        case .unsupportedPCMFormat:
            "Unsupported PCM audio format"
        case .playbackStartFailed:
            "Failed to start audio playback"
        case .playbackFinishedUnsuccessfully:
            "Audio playback finished unsuccessfully"
        case .audioEngineStartFailed(let message):
            "Failed to start audio engine: \(message)"
        case .decodingFailed(let message):
            "Failed to decode audio: \(message)"
        }
    }
}

@MainActor
@Observable
final class LiveVoiceAudioPlayer {
    private(set) var state: LiveVoiceAudioPlaybackState = .idle

    var isPlaying: Bool {
        state == .playing
    }

    var queuedChunkCount: Int {
        queuedChunks.count
    }

    @ObservationIgnored private let output: any LiveVoiceAudioOutput
    @ObservationIgnored private var queuedChunks: [LiveVoiceAudioChunk] = []
    @ObservationIgnored private var scheduledPlaybackCount = 0
    @ObservationIgnored private var hasNonPCMInFlight = false
    @ObservationIgnored private var playbackGeneration: UInt64 = 0
    @ObservationIgnored private var acceptsAudio = true
    @ObservationIgnored private var playbackWaiters: [CheckedContinuation<Void, Never>] = []

    init(output: (any LiveVoiceAudioOutput)? = nil) {
        self.output = output ?? AVFoundationLiveVoiceAudioOutput()
    }

    func enqueueTTSAudio(
        data: Data,
        mimeType: String,
        sampleRate: Int,
        channels: Int = 1
    ) {
        enqueueTTSAudio(
            LiveVoiceAudioChunk(
                data: data,
                mimeType: mimeType,
                sampleRate: sampleRate,
                channels: channels
            )
        )
    }

    func enqueueTTSAudio(_ chunk: LiveVoiceAudioChunk) {
        guard acceptsAudio else { return }
        guard !chunk.data.isEmpty else { return }

        queuedChunks.append(chunk)
        playNextChunkIfNeeded()
    }

    func handleInterrupt() {
        stop(reason: .interrupt)
    }

    func handleEnd() {
        stop(reason: .end)
    }

    func handleSessionError() {
        stop(reason: .sessionError)
    }

    func stop(reason: LiveVoiceAudioStopReason = .manual) {
        playbackGeneration &+= 1
        acceptsAudio = false
        queuedChunks.removeAll()
        scheduledPlaybackCount = 0
        hasNonPCMInFlight = false
        output.stop()
        state = .stopped(reason)
        notifyPlaybackWaiters()
    }

    func resetForNextResponse() {
        playbackGeneration &+= 1
        output.stop()
        queuedChunks.removeAll()
        scheduledPlaybackCount = 0
        hasNonPCMInFlight = false
        acceptsAudio = true
        state = .idle
        notifyPlaybackWaiters()
    }

    func waitUntilPlaybackFinishes() async {
        guard state == .playing || scheduledPlaybackCount > 0 || !queuedChunks.isEmpty else { return }

        await withCheckedContinuation { continuation in
            playbackWaiters.append(continuation)
        }
    }

    private func playNextChunkIfNeeded() {
        while acceptsAudio, !queuedChunks.isEmpty {
            if hasNonPCMInFlight {
                return
            }
            let chunk = queuedChunks[0]
            if scheduledPlaybackCount > 0, !chunk.isPCM {
                return
            }

            queuedChunks.removeFirst()
            let generation = playbackGeneration
            scheduledPlaybackCount += 1
            if !chunk.isPCM {
                hasNonPCMInFlight = true
            }
            state = .playing

            output.play(chunk) { [weak self] result in
                self?.handlePlaybackCompletion(result, generation: generation)
            }

            if !chunk.isPCM {
                return
            }
        }
    }

    private func handlePlaybackCompletion(_ result: Result<Void, Error>, generation: UInt64) {
        guard generation == playbackGeneration, scheduledPlaybackCount > 0 else { return }
        scheduledPlaybackCount -= 1
        if scheduledPlaybackCount == 0 {
            hasNonPCMInFlight = false
        }

        switch result {
        case .success:
            playNextChunkIfNeeded()
            if generation == playbackGeneration, queuedChunks.isEmpty, scheduledPlaybackCount == 0 {
                state = .idle
                notifyPlaybackWaiters()
            }

        case .failure(let error):
            playbackGeneration &+= 1
            acceptsAudio = false
            queuedChunks.removeAll()
            scheduledPlaybackCount = 0
            hasNonPCMInFlight = false
            output.stop()
            state = .failed(error.localizedDescription)
            notifyPlaybackWaiters()
        }
    }

    private func notifyPlaybackWaiters() {
        guard state != .playing, scheduledPlaybackCount == 0, queuedChunks.isEmpty else { return }

        let waiters = playbackWaiters
        playbackWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }
}

@MainActor
final class AVFoundationLiveVoiceAudioOutput: NSObject, LiveVoiceAudioOutput, AVAudioPlayerDelegate {
    private struct PCMFormatKey: Equatable {
        let sampleRate: Int
        let channels: Int
    }

    private var audioPlayer: AVAudioPlayer?
    private var pcmEngine: AVAudioEngine?
    private var pcmPlayerNode: AVAudioPlayerNode?
    private var pcmFormatKey: PCMFormatKey?
    private var completion: (@MainActor (Result<Void, Error>) -> Void)?

    func play(
        _ chunk: LiveVoiceAudioChunk,
        completion: @escaping @MainActor (Result<Void, Error>) -> Void
    ) {
        do {
            if chunk.isPCM {
                try playPCM(chunk, completion: completion)
                return
            }

            stop()
            self.completion = completion
            try playBufferedAudio(chunk)
        } catch {
            self.completion = nil
            completion(.failure(error))
        }
    }

    func stop() {
        completion = nil

        audioPlayer?.stop()
        audioPlayer?.delegate = nil
        audioPlayer = nil

        pcmPlayerNode?.stop()
        pcmEngine?.stop()
    }

    private func playBufferedAudio(_ chunk: LiveVoiceAudioChunk) throws {
        do {
            let player = try AVAudioPlayer(data: chunk.data)
            player.delegate = self
            audioPlayer = player

            guard player.play() else {
                throw LiveVoiceAudioOutputError.playbackStartFailed
            }
        } catch let error as LiveVoiceAudioOutputError {
            throw error
        } catch {
            throw LiveVoiceAudioOutputError.decodingFailed(error.localizedDescription)
        }
    }

    private func playPCM(
        _ chunk: LiveVoiceAudioChunk,
        completion: @escaping @MainActor (Result<Void, Error>) -> Void
    ) throws {
        guard chunk.channels == 1, chunk.sampleRate > 0 else {
            throw LiveVoiceAudioOutputError.unsupportedPCMFormat
        }
        guard chunk.data.count.isMultiple(of: MemoryLayout<Int16>.size) else {
            throw LiveVoiceAudioOutputError.malformedPCMData
        }

        let sampleCount = chunk.data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else {
            completion(.success(()))
            return
        }

        let key = PCMFormatKey(sampleRate: chunk.sampleRate, channels: chunk.channels)
        if let node = pcmPlayerNode, node.isPlaying, pcmFormatKey != nil, pcmFormatKey != key {
            throw LiveVoiceAudioOutputError.unsupportedPCMFormat
        }

        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Double(chunk.sampleRate),
            channels: AVAudioChannelCount(chunk.channels),
            interleaved: false
        ),
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: AVAudioFrameCount(sampleCount)
            ),
            let channelData = buffer.int16ChannelData
        else {
            throw LiveVoiceAudioOutputError.unsupportedPCMFormat
        }

        buffer.frameLength = AVAudioFrameCount(sampleCount)
        chunk.data.withUnsafeBytes { rawBuffer in
            guard let source = rawBuffer.bindMemory(to: Int16.self).baseAddress else { return }
            channelData[0].update(from: source, count: sampleCount)
        }

        try ensurePCMEngine(format: format, key: key)

        guard let node = pcmPlayerNode else {
            throw LiveVoiceAudioOutputError.playbackStartFailed
        }

        node.scheduleBuffer(
            buffer,
            completionCallbackType: .dataPlayedBack
        ) { _ in
            Task { @MainActor in
                completion(.success(()))
            }
        }
        if !node.isPlaying {
            node.play()
        }
    }

    private func ensurePCMEngine(format: AVAudioFormat, key: PCMFormatKey) throws {
        if let engine = pcmEngine, pcmPlayerNode != nil, pcmFormatKey == key {
            guard !engine.isRunning else { return }
            do {
                try engine.start()
                return
            } catch {
                throw LiveVoiceAudioOutputError.audioEngineStartFailed(error.localizedDescription)
            }
        }

        pcmPlayerNode?.stop()
        pcmEngine?.stop()

        let engine = AVAudioEngine()
        let node = AVAudioPlayerNode()
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.prepare()

        do {
            try engine.start()
        } catch {
            throw LiveVoiceAudioOutputError.audioEngineStartFailed(error.localizedDescription)
        }

        pcmEngine = engine
        pcmPlayerNode = node
        pcmFormatKey = key
    }

    private func complete(_ result: Result<Void, Error>) {
        guard let completion else { return }
        self.completion = nil
        completion(result)
    }

    // MARK: - AVAudioPlayerDelegate

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.complete(
                flag ? .success(()) : .failure(LiveVoiceAudioOutputError.playbackFinishedUnsuccessfully)
            )
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            self?.complete(
                .failure(
                    LiveVoiceAudioOutputError.decodingFailed(
                        error?.localizedDescription ?? "Unknown decoding error"
                    )
                )
            )
        }
    }
}
