import XCTest

@testable import VellumAssistantShared

final class AudioWavEncoderTests: XCTestCase {

    // MARK: - Header Structure

    func testHeaderSizeIs44Bytes() {
        let wav = AudioWavEncoder.encode(pcmData: Data(), format: .speech16kHz)
        XCTAssertEqual(wav.count, AudioWavEncoder.headerSize)
    }

    func testRIFFChunkID() {
        let wav = AudioWavEncoder.encode(pcmData: Data(), format: .speech16kHz)
        let riff = String(data: wav[0..<4], encoding: .ascii)
        XCTAssertEqual(riff, "RIFF")
    }

    func testWAVEFormat() {
        let wav = AudioWavEncoder.encode(pcmData: Data(), format: .speech16kHz)
        let wave = String(data: wav[8..<12], encoding: .ascii)
        XCTAssertEqual(wave, "WAVE")
    }

    func testFmtSubchunkID() {
        let wav = AudioWavEncoder.encode(pcmData: Data(), format: .speech16kHz)
        let fmt = String(data: wav[12..<16], encoding: .ascii)
        XCTAssertEqual(fmt, "fmt ")
    }

    func testDataSubchunkID() {
        let wav = AudioWavEncoder.encode(pcmData: Data(), format: .speech16kHz)
        let dataChunk = String(data: wav[36..<40], encoding: .ascii)
        XCTAssertEqual(dataChunk, "data")
    }

    func testAudioFormatIsPCM() {
        let wav = AudioWavEncoder.encode(pcmData: Data(), format: .speech16kHz)
        let audioFormat = readUInt16LE(wav, offset: 20)
        XCTAssertEqual(audioFormat, 1, "Audio format should be 1 (PCM)")
    }

    // MARK: - Header Field Values

    func testHeaderFieldsSpeech16kHz() {
        let pcm = Data(repeating: 0, count: 3200) // 100ms of 16kHz mono 16-bit
        let wav = AudioWavEncoder.encode(pcmData: pcm, format: .speech16kHz)

        // Channels
        XCTAssertEqual(readUInt16LE(wav, offset: 22), 1)
        // Sample rate
        XCTAssertEqual(readUInt32LE(wav, offset: 24), 16000)
        // Byte rate: 16000 * 1 * 16 / 8 = 32000
        XCTAssertEqual(readUInt32LE(wav, offset: 28), 32000)
        // Block align: 1 * 16 / 8 = 2
        XCTAssertEqual(readUInt16LE(wav, offset: 32), 2)
        // Bits per sample
        XCTAssertEqual(readUInt16LE(wav, offset: 34), 16)
    }

    func testHeaderFieldsStereo44kHz() {
        let format = AudioWavEncoder.Format(sampleRate: 44100, channels: 2, bitsPerSample: 16)
        let pcm = Data(repeating: 0, count: 176400) // 1s of 44.1kHz stereo 16-bit
        let wav = AudioWavEncoder.encode(pcmData: pcm, format: format)

        // Channels
        XCTAssertEqual(readUInt16LE(wav, offset: 22), 2)
        // Sample rate
        XCTAssertEqual(readUInt32LE(wav, offset: 24), 44100)
        // Byte rate: 44100 * 2 * 16 / 8 = 176400
        XCTAssertEqual(readUInt32LE(wav, offset: 28), 176400)
        // Block align: 2 * 16 / 8 = 4
        XCTAssertEqual(readUInt16LE(wav, offset: 32), 4)
        // Bits per sample
        XCTAssertEqual(readUInt16LE(wav, offset: 34), 16)
    }

    // MARK: - File Size Consistency

    func testFileSizeFieldIsConsistent() {
        let pcm = Data(repeating: 0xAB, count: 8000)
        let wav = AudioWavEncoder.encode(pcmData: pcm, format: .speech16kHz)

        // RIFF chunk size = total file size - 8
        let riffSize = readUInt32LE(wav, offset: 4)
        XCTAssertEqual(riffSize, UInt32(wav.count - 8))
    }

    func testDataSubchunkSizeMatchesPCMData() {
        let pcm = Data(repeating: 0xCD, count: 6400)
        let wav = AudioWavEncoder.encode(pcmData: pcm, format: .speech16kHz)

        let dataSize = readUInt32LE(wav, offset: 40)
        XCTAssertEqual(dataSize, UInt32(pcm.count))
    }

    func testTotalLengthEqualsHeaderPlusPCMData() {
        let pcm = Data(repeating: 0x42, count: 16000)
        let wav = AudioWavEncoder.encode(pcmData: pcm, format: .speech16kHz)

        XCTAssertEqual(wav.count, AudioWavEncoder.headerSize + pcm.count)
    }

    // MARK: - Payload Integrity

    func testPCMDataIsAppendedUnmodified() {
        var pcm = Data()
        // Write a known pattern: alternating 0x00 and 0xFF
        for i in 0..<100 {
            pcm.append(UInt8(i % 2 == 0 ? 0x00 : 0xFF))
        }
        let wav = AudioWavEncoder.encode(pcmData: pcm, format: .speech16kHz)

        let payload = wav[AudioWavEncoder.headerSize...]
        XCTAssertEqual(Data(payload), pcm)
    }

    func testEmptyPCMDataProducesHeaderOnly() {
        let wav = AudioWavEncoder.encode(pcmData: Data(), format: .speech16kHz)
        XCTAssertEqual(wav.count, AudioWavEncoder.headerSize)

        let dataSize = readUInt32LE(wav, offset: 40)
        XCTAssertEqual(dataSize, 0)
    }

    // MARK: - Int16 Sample Encoding

    func testEncodeFromInt16Samples() {
        let samples: [Int16] = [0, 1000, -1000, Int16.max, Int16.min]
        let wav = samples.withUnsafeBufferPointer { buffer in
            AudioWavEncoder.encode(samples: buffer, format: .speech16kHz)
        }

        // Total size: header (44) + 5 samples * 2 bytes = 54
        XCTAssertEqual(wav.count, 44 + 10)

        // Verify the data subchunk size
        let dataSize = readUInt32LE(wav, offset: 40)
        XCTAssertEqual(dataSize, 10)

        // Verify first sample (0) at offset 44
        let firstSample = readInt16LE(wav, offset: 44)
        XCTAssertEqual(firstSample, 0)

        // Verify second sample (1000) at offset 46
        let secondSample = readInt16LE(wav, offset: 46)
        XCTAssertEqual(secondSample, 1000)

        // Verify third sample (-1000) at offset 48
        let thirdSample = readInt16LE(wav, offset: 48)
        XCTAssertEqual(thirdSample, -1000)
    }

    // MARK: - Helpers

    private func readUInt16LE(_ data: Data, offset: Int) -> UInt16 {
        data.withUnsafeBytes { bytes in
            bytes.load(fromByteOffset: offset, as: UInt16.self).littleEndian
        }
    }

    private func readUInt32LE(_ data: Data, offset: Int) -> UInt32 {
        data.withUnsafeBytes { bytes in
            bytes.load(fromByteOffset: offset, as: UInt32.self).littleEndian
        }
    }

    private func readInt16LE(_ data: Data, offset: Int) -> Int16 {
        data.withUnsafeBytes { bytes in
            bytes.load(fromByteOffset: offset, as: Int16.self).littleEndian
        }
    }
}
