import AVFoundation
import XCTest
@testable import VellumAssistantLib

private final class MockLiveVoiceAudioEngineController: LiveVoiceAudioEngineControlling {
    var installCallCount = 0
    var stopAndRemoveTapCallCount = 0
    var stopCallCount = 0
    var installResult = true
    var lastBufferSize: AVAudioFrameCount?
    var tapBlock: AVAudioNodeTapBlock?

    func installTapAndStart(
        bufferSize: AVAudioFrameCount,
        block: @escaping AVAudioNodeTapBlock
    ) -> Bool {
        installCallCount += 1
        lastBufferSize = bufferSize
        tapBlock = block
        return installResult
    }

    func stopAndRemoveTap() {
        stopAndRemoveTapCallCount += 1
        tapBlock = nil
    }

    func stop() {
        stopCallCount += 1
    }
}

private final class MockLiveVoiceMicrophonePermission: LiveVoiceMicrophonePermissioning {
    var requestCallCount = 0
    var result = true

    func requestMicrophoneAccess() async -> Bool {
        requestCallCount += 1
        return result
    }
}

final class LiveVoiceAudioCaptureTests: XCTestCase {
    func testFloatPCMConvertsToInt16LittleEndianMonoChunk() {
        let buffer = makeBuffer(samples: [-1, -0.5, 0, 0.5, 1, -1.5, 1.5], sampleRate: 16_000)

        let chunk = LiveVoiceAudioCapture.makeChunk(from: buffer)

        XCTAssertEqual(chunk?.sampleRate, 16_000)
        XCTAssertEqual(chunk?.channelCount, 1)
        XCTAssertEqual(chunk?.frameCount, 7)
        XCTAssertEqual(chunk?.pcm16LittleEndian.count, 14)
        XCTAssertEqual(readInt16LE(chunk!.pcm16LittleEndian, offset: 0), Int16.min)
        XCTAssertEqual(readInt16LE(chunk!.pcm16LittleEndian, offset: 2), -16_384)
        XCTAssertEqual(readInt16LE(chunk!.pcm16LittleEndian, offset: 4), 0)
        XCTAssertEqual(readInt16LE(chunk!.pcm16LittleEndian, offset: 6), 16_383)
        XCTAssertEqual(readInt16LE(chunk!.pcm16LittleEndian, offset: 8), Int16.max)
        XCTAssertEqual(readInt16LE(chunk!.pcm16LittleEndian, offset: 10), Int16.min)
        XCTAssertEqual(readInt16LE(chunk!.pcm16LittleEndian, offset: 12), Int16.max)
    }

    func testCapturedBufferReportsChunkAndScaledAmplitude() async {
        let engine = MockLiveVoiceAudioEngineController()
        let permission = MockLiveVoiceMicrophonePermission()
        let capture = LiveVoiceAudioCapture(
            engineController: engine,
            microphonePermission: permission,
            bufferSize: 256
        )
        var chunks: [LiveVoiceAudioCaptureChunk] = []
        var amplitudes: [Float] = []

        let started = await capture.start(
            onChunk: { chunks.append($0) },
            onAmplitude: { amplitudes.append($0) }
        )

        XCTAssertTrue(started)
        XCTAssertEqual(engine.lastBufferSize, 256)

        let buffer = makeBuffer(samples: [0.1, -0.1, 0.1, -0.1], sampleRate: 24_000)
        engine.tapBlock?(buffer, AVAudioTime(sampleTime: 0, atRate: 24_000))

        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0].sampleRate, 24_000)
        XCTAssertEqual(chunks[0].frameCount, 4)
        XCTAssertEqual(readInt16LE(chunks[0].pcm16LittleEndian, offset: 0), 3_276)
        XCTAssertEqual(readInt16LE(chunks[0].pcm16LittleEndian, offset: 2), -3_276)
        XCTAssertEqual(amplitudes.count, 1)
        XCTAssertEqual(amplitudes[0], 0.5, accuracy: 0.0001)
    }

    func testStartingTwiceDoesNotInstallDuplicateTap() async {
        let engine = MockLiveVoiceAudioEngineController()
        let permission = MockLiveVoiceMicrophonePermission()
        let capture = LiveVoiceAudioCapture(
            engineController: engine,
            microphonePermission: permission
        )

        let firstStart = await capture.start(onChunk: { _ in })
        let secondStart = await capture.start(onChunk: { _ in XCTFail("Second start should not replace the active handler") })

        XCTAssertTrue(firstStart)
        XCTAssertTrue(secondStart)
        XCTAssertEqual(permission.requestCallCount, 1)
        XCTAssertEqual(engine.installCallCount, 1)
    }

    func testStoppingCaptureReleasesTapWithoutEngineShutdown() async {
        let engine = MockLiveVoiceAudioEngineController()
        let permission = MockLiveVoiceMicrophonePermission()
        let capture = LiveVoiceAudioCapture(
            engineController: engine,
            microphonePermission: permission
        )
        var amplitudes: [Float] = []

        _ = await capture.start(onChunk: { _ in }, onAmplitude: { amplitudes.append($0) })
        capture.stop()
        capture.stop()

        XCTAssertEqual(engine.stopAndRemoveTapCallCount, 1)
        XCTAssertEqual(engine.stopCallCount, 0)
        XCTAssertEqual(amplitudes, [0])
    }

    func testDeniedMicrophonePermissionDoesNotInstallTap() async {
        let engine = MockLiveVoiceAudioEngineController()
        let permission = MockLiveVoiceMicrophonePermission()
        permission.result = false
        let capture = LiveVoiceAudioCapture(
            engineController: engine,
            microphonePermission: permission
        )
        var amplitudes: [Float] = []

        let started = await capture.start(onChunk: { _ in }, onAmplitude: { amplitudes.append($0) })

        XCTAssertFalse(started)
        XCTAssertEqual(permission.requestCallCount, 1)
        XCTAssertEqual(engine.installCallCount, 0)
        XCTAssertEqual(engine.stopAndRemoveTapCallCount, 0)
        XCTAssertEqual(amplitudes, [0])
    }

    func testStopWhilePermissionRequestIsPendingPreventsTapInstall() async {
        let engine = MockLiveVoiceAudioEngineController()
        let permission = PendingLiveVoiceMicrophonePermission()
        let capture = LiveVoiceAudioCapture(
            engineController: engine,
            microphonePermission: permission
        )
        var amplitudes: [Float] = []

        let startTask = Task {
            await capture.start(onChunk: { _ in }, onAmplitude: { amplitudes.append($0) })
        }
        await permission.waitForRequest()

        capture.stop()
        await permission.complete(with: true)

        let started = await startTask.value

        XCTAssertFalse(started)
        XCTAssertEqual(engine.installCallCount, 0)
        XCTAssertEqual(engine.stopAndRemoveTapCallCount, 0)
        XCTAssertEqual(amplitudes, [0])
    }

    func testShutdownIsIdempotentAndPreventsRestart() async {
        let engine = MockLiveVoiceAudioEngineController()
        let permission = MockLiveVoiceMicrophonePermission()
        let capture = LiveVoiceAudioCapture(
            engineController: engine,
            microphonePermission: permission
        )

        _ = await capture.start(onChunk: { _ in })
        capture.shutdown()
        capture.shutdown()
        let restarted = await capture.start(onChunk: { _ in })

        XCTAssertFalse(restarted)
        XCTAssertEqual(engine.stopAndRemoveTapCallCount, 1)
        XCTAssertEqual(engine.stopCallCount, 1)
        XCTAssertEqual(engine.installCallCount, 1)
    }

    private func makeBuffer(samples: [Float], sampleRate: Double) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        )!
        let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(samples.count)
        )!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for (index, sample) in samples.enumerated() {
            buffer.floatChannelData![0][index] = sample
        }
        return buffer
    }

    private func readInt16LE(_ data: Data, offset: Int) -> Int16 {
        data.withUnsafeBytes { bytes in
            bytes.load(fromByteOffset: offset, as: Int16.self).littleEndian
        }
    }
}

private actor PendingLiveVoiceMicrophonePermission: LiveVoiceMicrophonePermissioning {
    private var continuation: CheckedContinuation<Bool, Never>?
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []

    func requestMicrophoneAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let waiters = requestWaiters
            requestWaiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
        }
    }

    func waitForRequest() async {
        if continuation != nil {
            return
        }
        await withCheckedContinuation { requestWaiters.append($0) }
    }

    func complete(with result: Bool) {
        continuation?.resume(returning: result)
        continuation = nil
    }
}
