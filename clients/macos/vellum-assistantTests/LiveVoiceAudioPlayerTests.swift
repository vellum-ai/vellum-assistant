import Foundation
import XCTest
@testable import VellumAssistantLib

@MainActor
private final class MockLiveVoiceAudioOutput: LiveVoiceAudioOutput {
    private(set) var playedChunks: [LiveVoiceAudioChunk] = []
    private(set) var stopCallCount = 0

    private var completions: [@MainActor (Result<Void, Error>) -> Void] = []

    func play(
        _ chunk: LiveVoiceAudioChunk,
        completion: @escaping @MainActor (Result<Void, Error>) -> Void
    ) {
        playedChunks.append(chunk)
        completions.append(completion)
    }

    func stop() {
        stopCallCount += 1
    }

    func completeNextSuccessfully() {
        guard !completions.isEmpty else {
            XCTFail("Expected a pending playback completion")
            return
        }

        let completion = completions.removeFirst()
        completion(.success(()))
    }

    func failNext(_ error: Error = TestPlaybackError()) {
        guard !completions.isEmpty else {
            XCTFail("Expected a pending playback completion")
            return
        }

        let completion = completions.removeFirst()
        completion(.failure(error))
    }
}

private struct TestPlaybackError: Error, LocalizedError {
    var errorDescription: String? { "test playback failure" }
}

@MainActor
final class LiveVoiceAudioPlayerTests: XCTestCase {
    private var output: MockLiveVoiceAudioOutput!
    private var player: LiveVoiceAudioPlayer!

    override func setUp() {
        super.setUp()
        output = MockLiveVoiceAudioOutput()
        player = LiveVoiceAudioPlayer(output: output)
    }

    override func tearDown() {
        player = nil
        output = nil
        super.tearDown()
    }

    func testPlaybackStartsLazilyOnFirstTTSChunk() {
        XCTAssertEqual(player.state, .idle)
        XCTAssertFalse(player.isPlaying)
        XCTAssertTrue(output.playedChunks.isEmpty)

        player.enqueueTTSAudio(chunk(sequence: 1))

        XCTAssertEqual(output.playedChunks.map(\.sequence), [1])
        XCTAssertEqual(player.state, .playing)
        XCTAssertTrue(player.isPlaying)
    }

    func testRapidEnqueuePreservesDeterministicChunkOrder() {
        let expectedSequences = Array(0..<100)

        for sequence in expectedSequences {
            player.enqueueTTSAudio(chunk(sequence: sequence))
        }

        XCTAssertEqual(output.playedChunks.map(\.sequence), [0])
        XCTAssertEqual(player.queuedChunkCount, 99)

        for expectedSequence in expectedSequences.dropFirst() {
            output.completeNextSuccessfully()
            XCTAssertEqual(output.playedChunks.last?.sequence, expectedSequence)
        }

        output.completeNextSuccessfully()

        XCTAssertEqual(output.playedChunks.map(\.sequence), expectedSequences)
        XCTAssertEqual(player.queuedChunkCount, 0)
        XCTAssertEqual(player.state, .idle)
        XCTAssertFalse(player.isPlaying)
    }

    func testStopDrainsQueuedChunksAndIgnoresLateCompletion() {
        player.enqueueTTSAudio(chunk(sequence: 1))
        player.enqueueTTSAudio(chunk(sequence: 2))
        player.enqueueTTSAudio(chunk(sequence: 3))

        XCTAssertEqual(output.playedChunks.map(\.sequence), [1])
        XCTAssertEqual(player.queuedChunkCount, 2)

        player.stop(reason: .interrupt)

        XCTAssertEqual(output.stopCallCount, 1)
        XCTAssertEqual(player.state, .stopped(.interrupt))
        XCTAssertEqual(player.queuedChunkCount, 0)
        XCTAssertFalse(player.isPlaying)

        output.completeNextSuccessfully()

        XCTAssertEqual(output.playedChunks.map(\.sequence), [1])
        XCTAssertEqual(player.state, .stopped(.interrupt))
    }

    func testStopPreventsLatePlaybackUntilReset() {
        player.enqueueTTSAudio(chunk(sequence: 1))
        player.stop(reason: .end)

        player.enqueueTTSAudio(chunk(sequence: 2))

        XCTAssertEqual(output.playedChunks.map(\.sequence), [1])
        XCTAssertEqual(player.state, .stopped(.end))

        player.resetForNextResponse()
        player.enqueueTTSAudio(chunk(sequence: 3))

        XCTAssertEqual(output.playedChunks.map(\.sequence), [1, 3])
        XCTAssertEqual(player.state, .playing)
    }

    func testInterruptEndAndSessionErrorStopImmediately() {
        player.enqueueTTSAudio(chunk(sequence: 1))
        player.handleInterrupt()
        XCTAssertEqual(output.stopCallCount, 1)
        XCTAssertEqual(player.state, .stopped(.interrupt))

        player.resetForNextResponse()
        player.enqueueTTSAudio(chunk(sequence: 2))
        player.handleEnd()
        XCTAssertEqual(output.stopCallCount, 3)
        XCTAssertEqual(player.state, .stopped(.end))

        player.resetForNextResponse()
        player.enqueueTTSAudio(chunk(sequence: 3))
        player.handleSessionError()
        XCTAssertEqual(output.stopCallCount, 5)
        XCTAssertEqual(player.state, .stopped(.sessionError))
    }

    func testPlaybackFailureStopsQueueAndPreventsLatePlayback() {
        player.enqueueTTSAudio(chunk(sequence: 1))
        player.enqueueTTSAudio(chunk(sequence: 2))

        output.failNext()

        XCTAssertEqual(player.state, .failed("test playback failure"))
        XCTAssertEqual(player.queuedChunkCount, 0)
        XCTAssertEqual(output.stopCallCount, 1)

        player.enqueueTTSAudio(chunk(sequence: 3))
        XCTAssertEqual(output.playedChunks.map(\.sequence), [1])
    }

    func testEmptyChunksAreIgnored() {
        player.enqueueTTSAudio(
            data: Data(),
            mimeType: "audio/pcm",
            sampleRate: 24_000,
            sequence: 1
        )

        XCTAssertTrue(output.playedChunks.isEmpty)
        XCTAssertEqual(player.state, .idle)
    }

    private func chunk(sequence: Int) -> LiveVoiceAudioChunk {
        LiveVoiceAudioChunk(
            data: Data([UInt8(sequence % 256), UInt8((sequence + 1) % 256)]),
            mimeType: "audio/pcm",
            sampleRate: 24_000,
            sequence: sequence
        )
    }
}
