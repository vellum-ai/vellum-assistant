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

        player.enqueueTTSAudio(chunk(id: 1))

        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1)])
        XCTAssertEqual(player.state, .playing)
        XCTAssertTrue(player.isPlaying)
    }

    func testRapidPCMEnqueueSchedulesContinuouslyInDeterministicOrder() {
        let expectedIds = Array(0..<100)

        for id in expectedIds {
            player.enqueueTTSAudio(chunk(id: id))
        }

        XCTAssertEqual(output.playedChunks.map(\.data), expectedIds.map { chunkData(id: $0) })
        XCTAssertEqual(player.queuedChunkCount, 0)
        XCTAssertEqual(output.stopCallCount, 0)

        for _ in expectedIds {
            output.completeNextSuccessfully()
        }

        XCTAssertEqual(player.queuedChunkCount, 0)
        XCTAssertEqual(player.state, .idle)
        XCTAssertFalse(player.isPlaying)
    }

    func testNonPCMChunksRemainSerial() {
        player.enqueueTTSAudio(chunk(id: 1, mimeType: "audio/mpeg"))
        player.enqueueTTSAudio(chunk(id: 2, mimeType: "audio/mpeg"))

        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1)])
        XCTAssertEqual(player.queuedChunkCount, 1)

        output.completeNextSuccessfully()

        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1), chunkData(id: 2)])
        XCTAssertEqual(player.queuedChunkCount, 0)
    }

    func testStopDrainsScheduledAndQueuedChunksAndIgnoresLateCompletion() {
        player.enqueueTTSAudio(chunk(id: 1))
        player.enqueueTTSAudio(chunk(id: 2))
        player.enqueueTTSAudio(chunk(id: 3))

        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1), chunkData(id: 2), chunkData(id: 3)])
        XCTAssertEqual(player.queuedChunkCount, 0)

        player.stop(reason: .interrupt)

        XCTAssertEqual(output.stopCallCount, 1)
        XCTAssertEqual(player.state, .stopped(.interrupt))
        XCTAssertEqual(player.queuedChunkCount, 0)
        XCTAssertFalse(player.isPlaying)

        output.completeNextSuccessfully()

        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1), chunkData(id: 2), chunkData(id: 3)])
        XCTAssertEqual(player.state, .stopped(.interrupt))
    }

    func testStopPreventsLatePlaybackUntilReset() {
        player.enqueueTTSAudio(chunk(id: 1))
        player.stop(reason: .end)

        player.enqueueTTSAudio(chunk(id: 2))

        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1)])
        XCTAssertEqual(player.state, .stopped(.end))

        player.resetForNextResponse()
        player.enqueueTTSAudio(chunk(id: 3))

        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1), chunkData(id: 3)])
        XCTAssertEqual(player.state, .playing)
    }

    func testInterruptEndAndSessionErrorStopImmediately() {
        player.enqueueTTSAudio(chunk(id: 1))
        player.handleInterrupt()
        XCTAssertEqual(output.stopCallCount, 1)
        XCTAssertEqual(player.state, .stopped(.interrupt))

        player.resetForNextResponse()
        player.enqueueTTSAudio(chunk(id: 2))
        player.handleEnd()
        XCTAssertEqual(output.stopCallCount, 3)
        XCTAssertEqual(player.state, .stopped(.end))

        player.resetForNextResponse()
        player.enqueueTTSAudio(chunk(id: 3))
        player.handleSessionError()
        XCTAssertEqual(output.stopCallCount, 5)
        XCTAssertEqual(player.state, .stopped(.sessionError))
    }

    func testPlaybackFailureStopsQueueAndPreventsLatePlayback() {
        player.enqueueTTSAudio(chunk(id: 1))
        player.enqueueTTSAudio(chunk(id: 2))

        output.failNext()

        XCTAssertEqual(player.state, .failed("test playback failure"))
        XCTAssertEqual(player.queuedChunkCount, 0)
        XCTAssertEqual(output.stopCallCount, 1)

        player.enqueueTTSAudio(chunk(id: 3))
        XCTAssertEqual(output.playedChunks.map(\.data), [chunkData(id: 1), chunkData(id: 2)])
    }

    func testEmptyChunksAreIgnored() {
        player.enqueueTTSAudio(
            data: Data(),
            mimeType: "audio/pcm",
            sampleRate: 24_000
        )

        XCTAssertTrue(output.playedChunks.isEmpty)
        XCTAssertEqual(player.state, .idle)
    }

    private func chunk(id: Int, mimeType: String = "audio/pcm") -> LiveVoiceAudioChunk {
        LiveVoiceAudioChunk(
            data: chunkData(id: id),
            mimeType: mimeType,
            sampleRate: 24_000
        )
    }

    private func chunkData(id: Int) -> Data {
        Data([UInt8(id % 256), UInt8((id + 1) % 256)])
    }
}
