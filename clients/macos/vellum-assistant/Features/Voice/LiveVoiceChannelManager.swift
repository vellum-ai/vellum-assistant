import Foundation
import Observation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LiveVoiceChannelManager")

protocol LiveVoiceAudioCapturing: AnyObject {
    func start(onChunk: @escaping (LiveVoiceAudioCaptureChunk) -> Void) async -> Bool
    func stop()
    func shutdown()
}

extension LiveVoiceAudioCapture: LiveVoiceAudioCapturing {
    func start(onChunk: @escaping (LiveVoiceAudioCaptureChunk) -> Void) async -> Bool {
        await start(onChunk: onChunk, onAmplitude: nil)
    }
}

@MainActor
protocol LiveVoiceAudioPlaying: AnyObject {
    var isPlaying: Bool { get }

    func enqueueTTSAudio(
        data: Data,
        mimeType: String,
        sampleRate: Int,
        channels: Int
    )
    func handleInterrupt()
    func handleEnd()
    func handleSessionError()
    func resetForNextResponse()
    func waitUntilPlaybackFinishes() async
}

extension LiveVoiceAudioPlayer: LiveVoiceAudioPlaying {}

@MainActor
@Observable
final class LiveVoiceChannelManager {
    enum State: Equatable {
        case idle
        case connecting
        case listening
        case transcribing
        case thinking
        case speaking
        case ending
        case failed
    }

    private(set) var state: State = .idle
    private(set) var activeConversationId: String?
    private(set) var sessionId: String?
    private(set) var partialTranscript: String = ""
    private(set) var finalTranscript: String = ""
    private(set) var assistantTranscript: String = ""
    private(set) var inputAmplitude: Float = 0
    private(set) var errorMessage: String = ""

    var isActive: Bool {
        switch state {
        case .idle, .failed:
            return false
        case .connecting, .listening, .transcribing, .thinking, .speaking, .ending:
            return true
        }
    }

    @ObservationIgnored private let clientFactory: @MainActor () -> any LiveVoiceChannelClientProtocol
    @ObservationIgnored private let capture: any LiveVoiceAudioCapturing
    @ObservationIgnored private let playback: any LiveVoiceAudioPlaying
    @ObservationIgnored private let bargeInAmplitudeThreshold: Float
    @ObservationIgnored private let speechAmplitudeThreshold: Float
    @ObservationIgnored private let silenceDurationBeforeRelease: TimeInterval
    @ObservationIgnored private let minimumSpeechDurationBeforeRelease: TimeInterval
    @ObservationIgnored private let minimumBargeInSpeechDuration: TimeInterval

    @ObservationIgnored private var client: (any LiveVoiceChannelClientProtocol)?
    @ObservationIgnored private var captureStartTask: Task<Void, Never>?
    @ObservationIgnored private var sessionGeneration: UInt64 = 0
    @ObservationIgnored private var captureRunning = false
    @ObservationIgnored private var captureStartInFlight = false
    @ObservationIgnored private var responseAudioStarted = false
    @ObservationIgnored private var interruptSentForCurrentResponse = false
    @ObservationIgnored private var speechDurationInCurrentUtterance: TimeInterval = 0
    @ObservationIgnored private var silenceDurationAfterSpeech: TimeInterval = 0
    @ObservationIgnored private var automaticReleaseInFlight = false
    @ObservationIgnored private var loudDurationForPendingBargeIn: TimeInterval = 0

    init(
        clientFactory: @escaping @MainActor () -> any LiveVoiceChannelClientProtocol = { LiveVoiceChannelClient() },
        capture: any LiveVoiceAudioCapturing = LiveVoiceAudioCapture(),
        playback: (any LiveVoiceAudioPlaying)? = nil,
        bargeInAmplitudeThreshold: Float = 0.05,
        speechAmplitudeThreshold: Float = 0.03,
        silenceDurationBeforeRelease: TimeInterval = 1.0,
        minimumSpeechDurationBeforeRelease: TimeInterval = 0.12,
        minimumBargeInSpeechDuration: TimeInterval = 0.15
    ) {
        self.clientFactory = clientFactory
        self.capture = capture
        self.playback = playback ?? LiveVoiceAudioPlayer()
        self.bargeInAmplitudeThreshold = bargeInAmplitudeThreshold
        self.speechAmplitudeThreshold = speechAmplitudeThreshold
        self.silenceDurationBeforeRelease = silenceDurationBeforeRelease
        self.minimumSpeechDurationBeforeRelease = minimumSpeechDurationBeforeRelease
        self.minimumBargeInSpeechDuration = minimumBargeInSpeechDuration
    }

    func start(conversationId: String) async {
        let trimmedConversationId = conversationId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedConversationId.isEmpty else {
            failWithoutActiveClient(message: "A conversation is required to start live voice.")
            return
        }
        guard state == .idle || state == .failed else { return }

        sessionGeneration &+= 1
        let generation = sessionGeneration
        let newClient = clientFactory()

        resetObservedSessionState(conversationId: trimmedConversationId)
        client = newClient
        state = .connecting

        await newClient.start(
            conversationId: trimmedConversationId,
            audioFormat: .pcm16kMono,
            onEvent: { [weak self] event in
                self?.handle(event, generation: generation)
            },
            onFailure: { [weak self] failure in
                self?.handle(failure, generation: generation)
            }
        )
    }

    func interruptSpeakingAndStartListening(conversationId: String) async {
        let trimmedConversationId = conversationId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedConversationId.isEmpty else {
            failWithoutActiveClient(message: "A conversation is required to start live voice.")
            return
        }
        guard client != nil, state != .idle, state != .failed else {
            await start(conversationId: trimmedConversationId)
            return
        }

        sessionGeneration &+= 1
        let interruptedClient = client

        stopCapture()
        playback.handleInterrupt()
        resetIgnoredSessionState()
        resetObservedSessionState(conversationId: nil)
        state = .idle

        await interruptedClient?.interrupt()
        await interruptedClient?.close()
        await start(conversationId: trimmedConversationId)
    }

    func stopListening() async {
        guard state != .idle, state != .failed, state != .ending else { return }
        guard captureRunning || captureStartInFlight else { return }

        stopCapture()
        await client?.releasePushToTalk()

        if state == .listening {
            state = .transcribing
        }
    }

    func end() async {
        guard state != .failed, state != .ending else { return }
        guard state != .idle || client != nil || captureRunning || captureStartInFlight else { return }

        state = .ending
        sessionGeneration &+= 1
        let clientToEnd = client

        stopCapture()
        playback.handleEnd()
        resetIgnoredSessionState()

        await clientToEnd?.end()

        resetObservedSessionState(conversationId: nil)
        state = .idle
    }

    private func resetObservedSessionState(conversationId: String?) {
        activeConversationId = conversationId
        sessionId = nil
        partialTranscript = ""
        finalTranscript = ""
        assistantTranscript = ""
        inputAmplitude = 0
        errorMessage = ""
        resetVoiceActivityTracking()
    }

    private func resetIgnoredSessionState() {
        client = nil
        responseAudioStarted = false
        interruptSentForCurrentResponse = false
        automaticReleaseInFlight = false
    }

    private func resetVoiceActivityTracking() {
        speechDurationInCurrentUtterance = 0
        silenceDurationAfterSpeech = 0
        automaticReleaseInFlight = false
        loudDurationForPendingBargeIn = 0
    }

    private func handle(_ event: LiveVoiceChannelEvent, generation: UInt64) {
        guard generation == sessionGeneration else { return }

        switch event {
        case .ready(let sessionId, let conversationId):
            guard state == .connecting else { return }
            self.sessionId = sessionId
            activeConversationId = conversationId
            startCapture(generation: generation)

        case .sttPartial(let text, _):
            update(&partialTranscript, to: text)
            if captureRunning {
                state = .listening
            } else if state == .listening || state == .transcribing {
                state = .transcribing
            }

        case .sttFinal(let text, _):
            update(&finalTranscript, to: text)
            update(&partialTranscript, to: "")
            if state != .ending {
                state = captureRunning ? .listening : .thinking
            }

        case .thinking:
            prepareForAssistantResponse()
            if state != .ending {
                state = .thinking
            }

        case .assistantTextDelta(let text, _):
            guard !text.isEmpty else { return }
            assistantTranscript += text
            if state == .listening || state == .transcribing {
                state = .thinking
            }

        case .ttsAudio(let data, let mimeType, let sampleRate, _):
            beginAssistantAudioIfNeeded()
            playback.enqueueTTSAudio(
                data: data,
                mimeType: mimeType,
                sampleRate: sampleRate,
                channels: 1
            )
            state = .speaking

        case .ttsDone:
            closeCompletedUtteranceSessionAfterPlayback(generation: generation)

        case .metrics, .archived:
            break
        }
    }

    private func handle(_ failure: LiveVoiceChannelFailure, generation: UInt64) {
        guard generation == sessionGeneration else { return }

        log.warning("Live voice session failed: \(failure.localizedDescription, privacy: .public)")
        sessionGeneration &+= 1
        stopCapture()
        playback.handleSessionError()

        let failedClient = client
        resetIgnoredSessionState()

        errorMessage = failure.errorDescription ?? failure.localizedDescription
        state = .failed

        Task {
            await failedClient?.close()
        }
    }

    private func failWithoutActiveClient(message: String) {
        resetObservedSessionState(conversationId: nil)
        stopCapture()
        playback.handleSessionError()
        resetIgnoredSessionState()
        errorMessage = message
        state = .failed
    }

    private func startCapture(generation: UInt64) {
        captureStartTask?.cancel()
        captureStartTask = Task { @MainActor [weak self] in
            guard let self, generation == self.sessionGeneration else { return }

            self.captureStartInFlight = true
            let started = await self.capture.start { [weak self] chunk in
                Task { @MainActor [weak self] in
                    self?.handleCapturedAudioChunk(chunk, generation: generation)
                }
            }
            self.captureStartInFlight = false
            self.captureStartTask = nil

            guard generation == self.sessionGeneration, !Task.isCancelled else {
                if started {
                    self.capture.stop()
                }
                return
            }

            guard started else {
                self.handle(
                    .protocolError(code: "capture_failed", message: "Microphone capture could not start."),
                    generation: generation
                )
                return
            }

            self.captureRunning = true
            if self.state == .connecting || self.state == .idle {
                self.state = .listening
            }
        }
    }

    private func handleCapturedAudioChunk(_ chunk: LiveVoiceAudioCaptureChunk, generation: UInt64) {
        guard generation == sessionGeneration, captureRunning else { return }

        update(&inputAmplitude, to: chunk.amplitude)

        let audioData = chunk.pcm16LittleEndian
        if !audioData.isEmpty, let client {
            Task {
                await client.sendAudio(audioData)
            }
        }

        updateAutomaticPushToTalkRelease(with: chunk, generation: generation)
        updateBargeInTracking(with: chunk, generation: generation)
    }

    private func chunkDuration(_ chunk: LiveVoiceAudioCaptureChunk) -> TimeInterval {
        guard chunk.sampleRate > 0, chunk.frameCount > 0 else { return 0 }
        return TimeInterval(chunk.frameCount) / TimeInterval(chunk.sampleRate)
    }

    private func updateAutomaticPushToTalkRelease(
        with chunk: LiveVoiceAudioCaptureChunk,
        generation: UInt64
    ) {
        guard state == .listening, captureRunning, client != nil else { return }

        let duration = chunkDuration(chunk)
        guard duration > 0 else { return }

        if chunk.amplitude >= speechAmplitudeThreshold {
            speechDurationInCurrentUtterance += duration
            silenceDurationAfterSpeech = 0
            return
        }

        guard speechDurationInCurrentUtterance >= minimumSpeechDurationBeforeRelease else { return }
        silenceDurationAfterSpeech += duration

        guard silenceDurationAfterSpeech >= silenceDurationBeforeRelease else { return }
        automaticallyReleasePushToTalk(generation: generation)
    }

    /// Requires a short run of consecutive over-threshold chunks before
    /// treating captured audio as an intentional barge-in. A single loud
    /// chunk is often a cough, click, or other transient noise; genuine
    /// speech sustains above the threshold for multiple consecutive chunks.
    /// Any chunk that dips back below the threshold resets the accumulator,
    /// so transient noise never accumulates toward the gate.
    private func updateBargeInTracking(with chunk: LiveVoiceAudioCaptureChunk, generation: UInt64) {
        guard chunk.amplitude >= bargeInAmplitudeThreshold else {
            loudDurationForPendingBargeIn = 0
            return
        }

        loudDurationForPendingBargeIn += chunkDuration(chunk)
        guard loudDurationForPendingBargeIn >= minimumBargeInSpeechDuration else { return }

        loudDurationForPendingBargeIn = 0
        interruptIfAssistantAudioIsPlaying(generation: generation)
    }

    private func automaticallyReleasePushToTalk(generation: UInt64) {
        guard !automaticReleaseInFlight else { return }
        automaticReleaseInFlight = true

        Task { @MainActor [weak self] in
            guard let self, generation == self.sessionGeneration else { return }
            await self.stopListening()
        }
    }

    private func interruptIfAssistantAudioIsPlaying(generation: UInt64) {
        guard generation == sessionGeneration else { return }
        guard playback.isPlaying, !interruptSentForCurrentResponse else { return }

        interruptSentForCurrentResponse = true
        playback.handleInterrupt()
        if state == .speaking {
            state = captureRunning ? .listening : .idle
        }

        let interruptedClient = client
        Task {
            await interruptedClient?.interrupt()
        }
    }

    private func prepareForAssistantResponse() {
        responseAudioStarted = false
        interruptSentForCurrentResponse = false
        loudDurationForPendingBargeIn = 0
        update(&assistantTranscript, to: "")
    }

    private func beginAssistantAudioIfNeeded() {
        guard !responseAudioStarted else { return }

        responseAudioStarted = true
        interruptSentForCurrentResponse = false
        playback.resetForNextResponse()
    }

    private func closeCompletedUtteranceSessionAfterPlayback(generation: UInt64) {
        responseAudioStarted = false
        let completedClient = client

        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.playback.waitUntilPlaybackFinishes()
            guard generation == self.sessionGeneration else { return }

            self.sessionGeneration &+= 1
            self.stopCapture()
            self.resetIgnoredSessionState()
            self.sessionId = nil
            self.state = .idle
            await completedClient?.close()
        }
    }

    private func stopCapture() {
        captureStartTask?.cancel()
        captureStartTask = nil

        if captureRunning || captureStartInFlight {
            capture.stop()
        }
        captureRunning = false
        captureStartInFlight = false
        inputAmplitude = 0
        resetVoiceActivityTracking()
    }

    private func update<T: Equatable>(_ value: inout T, to newValue: T) {
        guard value != newValue else { return }
        value = newValue
    }

    deinit {
        captureStartTask?.cancel()
        capture.shutdown()
    }
}
