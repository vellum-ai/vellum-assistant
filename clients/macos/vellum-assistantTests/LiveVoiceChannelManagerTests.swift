import Foundation
import Observation
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
private final class FakeLiveVoiceChannelClient: LiveVoiceChannelClientProtocol, @unchecked Sendable {
    private(set) var startCalls: [(conversationId: String?, audioFormat: LiveVoiceChannelAudioFormat)] = []
    private(set) var audioFrames: [Data] = []
    private(set) var releasePushToTalkCallCount = 0
    private(set) var interruptCallCount = 0
    private(set) var endCallCount = 0
    private(set) var closeCallCount = 0

    private var onEvent: (@MainActor (LiveVoiceChannelEvent) -> Void)?
    private var onFailure: (@MainActor (LiveVoiceChannelFailure) -> Void)?

    func start(
        conversationId: String?,
        audioFormat: LiveVoiceChannelAudioFormat,
        onEvent: @escaping @MainActor (LiveVoiceChannelEvent) -> Void,
        onFailure: @escaping @MainActor (LiveVoiceChannelFailure) -> Void
    ) async {
        startCalls.append((conversationId, audioFormat))
        self.onEvent = onEvent
        self.onFailure = onFailure
    }

    func sendAudio(_ data: Data) async {
        audioFrames.append(data)
    }

    func releasePushToTalk() async {
        releasePushToTalkCallCount += 1
    }

    func interrupt() async {
        interruptCallCount += 1
    }

    func end() async {
        endCallCount += 1
    }

    func close() async {
        closeCallCount += 1
    }

    func emit(_ event: LiveVoiceChannelEvent) {
        onEvent?(event)
    }

    func fail(_ failure: LiveVoiceChannelFailure) {
        onFailure?(failure)
    }
}

private final class FakeLiveVoiceAudioCapture: LiveVoiceAudioCapturing {
    var startResult = true
    private(set) var startCallCount = 0
    private(set) var stopCallCount = 0
    private(set) var shutdownCallCount = 0

    private var onChunk: ((LiveVoiceAudioCaptureChunk) -> Void)?

    func start(onChunk: @escaping (LiveVoiceAudioCaptureChunk) -> Void) async -> Bool {
        startCallCount += 1
        self.onChunk = onChunk
        return startResult
    }

    func stop() {
        stopCallCount += 1
        onChunk = nil
    }

    func shutdown() {
        shutdownCallCount += 1
        onChunk = nil
    }

    func emitChunk(
        data: Data = Data([1, 2, 3, 4]),
        sampleRate: Int = 16_000,
        channelCount: Int = 1,
        frameCount: Int = 2,
        amplitude: Float = 0.01
    ) {
        onChunk?(
            LiveVoiceAudioCaptureChunk(
                pcm16LittleEndian: data,
                sampleRate: sampleRate,
                channelCount: channelCount,
                frameCount: frameCount,
                amplitude: amplitude
            )
        )
    }
}

@MainActor
private final class FakeLiveVoiceAudioPlayback: LiveVoiceAudioPlaying {
    private(set) var enqueuedChunks: [LiveVoiceAudioChunk] = []
    private(set) var interruptCallCount = 0
    private(set) var endCallCount = 0
    private(set) var sessionErrorCallCount = 0
    private(set) var resetCallCount = 0

    var isPlaying = false

    func enqueueTTSAudio(
        data: Data,
        mimeType: String,
        sampleRate: Int,
        channels: Int,
        sequence: Int?
    ) {
        enqueuedChunks.append(
            LiveVoiceAudioChunk(
                data: data,
                mimeType: mimeType,
                sampleRate: sampleRate,
                channels: channels,
                sequence: sequence
            )
        )
        isPlaying = true
    }

    func handleInterrupt() {
        interruptCallCount += 1
        isPlaying = false
    }

    func handleEnd() {
        endCallCount += 1
        isPlaying = false
    }

    func handleSessionError() {
        sessionErrorCallCount += 1
        isPlaying = false
    }

    func resetForNextResponse() {
        resetCallCount += 1
        enqueuedChunks.removeAll()
        isPlaying = false
    }
}

@MainActor
final class LiveVoiceChannelManagerTests: XCTestCase {
    private var client: FakeLiveVoiceChannelClient!
    private var capture: FakeLiveVoiceAudioCapture!
    private var playback: FakeLiveVoiceAudioPlayback!
    private var manager: LiveVoiceChannelManager!

    override func setUp() {
        super.setUp()
        client = FakeLiveVoiceChannelClient()
        capture = FakeLiveVoiceAudioCapture()
        playback = FakeLiveVoiceAudioPlayback()
        manager = LiveVoiceChannelManager(
            clientFactory: { [client] in client! },
            capture: capture,
            playback: playback,
            bargeInAmplitudeThreshold: 0.2
        )
    }

    override func tearDown() {
        manager = nil
        playback = nil
        capture = nil
        client = nil
        super.tearDown()
    }

    func testStartOpensClientAndStartsCaptureAfterReady() async {
        await manager.start(conversationId: " conv-123 ")

        XCTAssertEqual(manager.state, .connecting)
        XCTAssertEqual(manager.activeConversationId, "conv-123")
        XCTAssertEqual(client.startCalls.count, 1)
        XCTAssertEqual(client.startCalls[0].conversationId, "conv-123")
        XCTAssertEqual(client.startCalls[0].audioFormat, .pcm16kMono)
        XCTAssertEqual(capture.startCallCount, 0)

        client.emit(.ready(sessionId: "session-123", conversationId: "conv-123"))
        await flushAsyncTasks()

        XCTAssertEqual(manager.state, .listening)
        XCTAssertEqual(manager.sessionId, "session-123")
        XCTAssertEqual(capture.startCallCount, 1)
    }

    func testAudioChunksStreamWithoutMutatingObservedState() async {
        await startReadySession()

        let observedInvalidations = ObservationCounter()
        withObservationTracking {
            _ = manager.state
            _ = manager.partialTranscript
            _ = manager.finalTranscript
            _ = manager.assistantTranscript
        } onChange: {
            Task { @MainActor in observedInvalidations.increment() }
        }

        capture.emitChunk(data: Data([1, 2]), amplitude: 0.01)
        capture.emitChunk(data: Data([3, 4]), amplitude: 0.01)
        capture.emitChunk(data: Data([5, 6]), amplitude: 0.01)
        await flushAsyncTasks()

        XCTAssertEqual(client.audioFrames, [Data([1, 2]), Data([3, 4]), Data([5, 6])])
        XCTAssertEqual(observedInvalidations.value, 0)
        XCTAssertEqual(manager.state, .listening)
    }

    func testStopListeningSendsPushToTalkRelease() async {
        await startReadySession()

        await manager.stopListening()

        XCTAssertEqual(capture.stopCallCount, 1)
        XCTAssertEqual(client.releasePushToTalkCallCount, 1)
        XCTAssertEqual(manager.state, .transcribing)
    }

    func testSttEventsUpdateTranscriptState() async {
        await startReadySession()

        client.emit(.sttPartial(text: "hel", seq: 1))
        XCTAssertEqual(manager.state, .transcribing)
        XCTAssertEqual(manager.partialTranscript, "hel")
        XCTAssertEqual(manager.finalTranscript, "")

        client.emit(.sttFinal(text: "hello", seq: 2))
        XCTAssertEqual(manager.state, .thinking)
        XCTAssertEqual(manager.partialTranscript, "")
        XCTAssertEqual(manager.finalTranscript, "hello")
    }

    func testAssistantSpeechStreamsToPlaybackAndClosesSessionAfterTtsDone() async {
        await startReadySession()
        await manager.stopListening()

        client.emit(.thinking(turnId: "turn-123"))
        client.emit(.assistantTextDelta(text: "Hi", seq: 3))
        client.emit(.ttsAudio(data: Data([9, 8]), mimeType: "audio/pcm", sampleRate: 16_000, seq: 4))

        XCTAssertEqual(manager.state, .speaking)
        XCTAssertEqual(manager.assistantTranscript, "Hi")
        XCTAssertEqual(playback.resetCallCount, 1)
        XCTAssertEqual(playback.enqueuedChunks.count, 1)
        XCTAssertEqual(playback.enqueuedChunks[0].data, Data([9, 8]))
        XCTAssertEqual(playback.enqueuedChunks[0].mimeType, "audio/pcm")
        XCTAssertEqual(playback.enqueuedChunks[0].sampleRate, 16_000)
        XCTAssertEqual(playback.enqueuedChunks[0].sequence, 4)

        client.emit(.ttsDone(turnId: "turn-123"))
        await flushAsyncTasks()

        XCTAssertEqual(manager.state, .idle)
        XCTAssertNil(manager.sessionId)
        XCTAssertEqual(client.closeCallCount, 1)
    }

    func testSpeakingOverAssistantAudioSendsInterruptOnce() async {
        await startReadySession()

        client.emit(.ttsAudio(data: Data([9, 8]), mimeType: "audio/pcm", sampleRate: 16_000, seq: 4))
        XCTAssertEqual(manager.state, .speaking)
        XCTAssertTrue(playback.isPlaying)

        capture.emitChunk(data: Data([1, 2]), amplitude: 0.5)
        capture.emitChunk(data: Data([3, 4]), amplitude: 0.7)
        await flushAsyncTasks()

        XCTAssertEqual(playback.interruptCallCount, 1)
        XCTAssertEqual(client.interruptCallCount, 1)
        XCTAssertEqual(client.audioFrames, [Data([1, 2]), Data([3, 4])])
        XCTAssertEqual(manager.state, .listening)
    }

    func testManualBargeInInterruptsAndStartsFreshSession() async {
        let firstClient = FakeLiveVoiceChannelClient()
        let secondClient = FakeLiveVoiceChannelClient()
        var factoryCalls = 0
        manager = LiveVoiceChannelManager(
            clientFactory: {
                factoryCalls += 1
                return factoryCalls == 1 ? firstClient : secondClient
            },
            capture: capture,
            playback: playback,
            bargeInAmplitudeThreshold: 0.2
        )

        await manager.start(conversationId: "conv-123")
        firstClient.emit(.ready(sessionId: "session-1", conversationId: "conv-123"))
        await flushAsyncTasks()
        await manager.stopListening()
        firstClient.emit(.ttsAudio(data: Data([9, 8]), mimeType: "audio/pcm", sampleRate: 16_000, seq: 4))

        XCTAssertEqual(manager.state, .speaking)

        await manager.interruptSpeakingAndStartListening(conversationId: "conv-123")

        XCTAssertEqual(firstClient.interruptCallCount, 1)
        XCTAssertEqual(firstClient.closeCallCount, 1)
        XCTAssertEqual(playback.interruptCallCount, 1)
        XCTAssertEqual(secondClient.startCalls.count, 1)
        XCTAssertEqual(secondClient.startCalls[0].conversationId, "conv-123")
        XCTAssertEqual(manager.state, .connecting)

        secondClient.emit(.ready(sessionId: "session-2", conversationId: "conv-123"))
        await flushAsyncTasks()

        XCTAssertEqual(manager.state, .listening)
        XCTAssertEqual(capture.startCallCount, 2)
    }

    func testEndCleansUpResourcesAndReturnsToIdle() async {
        await startReadySession()
        client.emit(.ttsAudio(data: Data([9, 8]), mimeType: "audio/pcm", sampleRate: 16_000, seq: 4))

        await manager.end()

        XCTAssertEqual(client.endCallCount, 1)
        XCTAssertEqual(capture.stopCallCount, 1)
        XCTAssertEqual(playback.endCallCount, 1)
        XCTAssertEqual(manager.state, .idle)
        XCTAssertNil(manager.activeConversationId)
        XCTAssertNil(manager.sessionId)
    }

    func testNextStartCreatesFreshClientAfterTtsDone() async {
        let firstClient = FakeLiveVoiceChannelClient()
        let secondClient = FakeLiveVoiceChannelClient()
        var factoryCalls = 0
        manager = LiveVoiceChannelManager(
            clientFactory: {
                factoryCalls += 1
                return factoryCalls == 1 ? firstClient : secondClient
            },
            capture: capture,
            playback: playback,
            bargeInAmplitudeThreshold: 0.2
        )

        await manager.start(conversationId: "conv-123")
        firstClient.emit(.ready(sessionId: "session-1", conversationId: "conv-123"))
        await flushAsyncTasks()
        await manager.stopListening()
        firstClient.emit(.ttsDone(turnId: "turn-1"))
        await flushAsyncTasks()

        XCTAssertEqual(manager.state, .idle)
        XCTAssertEqual(firstClient.closeCallCount, 1)

        await manager.start(conversationId: "conv-123")

        XCTAssertEqual(factoryCalls, 2)
        XCTAssertEqual(firstClient.startCalls.count, 1)
        XCTAssertEqual(secondClient.startCalls.count, 1)
        XCTAssertEqual(secondClient.startCalls[0].conversationId, "conv-123")
    }

    func testFailureCleansUpResourcesAndStoresError() async {
        await startReadySession()

        client.fail(.connectionFailed(message: "connection dropped"))
        await flushAsyncTasks()

        XCTAssertEqual(manager.state, .failed)
        XCTAssertEqual(manager.errorMessage, "connection dropped")
        XCTAssertEqual(capture.stopCallCount, 1)
        XCTAssertEqual(playback.sessionErrorCallCount, 1)
        XCTAssertEqual(client.closeCallCount, 1)
    }

    func testCaptureStartFailureFailsSession() async {
        capture.startResult = false

        await manager.start(conversationId: "conv-123")
        client.emit(.ready(sessionId: "session-123", conversationId: "conv-123"))
        await flushAsyncTasks()

        XCTAssertEqual(manager.state, .failed)
        XCTAssertEqual(manager.errorMessage, "Microphone capture could not start.")
        XCTAssertEqual(playback.sessionErrorCallCount, 1)
        XCTAssertEqual(client.closeCallCount, 1)
    }

    private func startReadySession() async {
        await manager.start(conversationId: "conv-123")
        client.emit(.ready(sessionId: "session-123", conversationId: "conv-123"))
        await flushAsyncTasks()
        XCTAssertEqual(manager.state, .listening)
    }

    private func flushAsyncTasks() async {
        await Task.yield()
        try? await Task.sleep(nanoseconds: 1_000_000)
    }
}

@MainActor
private final class ObservationCounter {
    private(set) var value = 0

    func increment() {
        value += 1
    }
}
